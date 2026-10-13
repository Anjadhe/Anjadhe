#!/usr/bin/env node
/**
 * Threads demo eval, tier 1 (docs/THREADS_DEMO.md): the demo's four stories
 * run through the app's OWN placement, look and drawer against a model.
 *
 * For each story the scenario's messages (scripts/sim-scenarios/
 * threads-demo.json, with the extraction each should yield) go through the
 * real filer's door (Matters.file), the real placement (Senders.sweep), the
 * real look (SenderLook.look over Coach.runLook and AgentLoop, with its own
 * checks) and the real drawer (ThreadPanelCore.blocksFor). Only the model
 * transport, the stores, the calendar and the cards on Now are stubbed.
 * Extraction itself is not run here (tests/email-insight-eval.js gates it).
 *
 * The numbers (all should be zero):
 *   SENDERS WRONG     a message in another story's sender, a sender too big,
 *                     or a story split across senders
 *   FOLDERS MISSING   a message that should have a folder and has none
 *   RAISES MISSED     a story whose card did not come, or came about the
 *                     wrong thing
 *   NUMBERS MISSING   a card without the figure the demo's card shows
 *   NUMBERS NOT READ  raises refused for a number nobody read (vetRaise)
 *   ANSWERS MISSING   a card with fewer one-tap answers than the demo's (G1)
 *   BLOCKS WRONG      the drawer missing a block the demo shows
 *   INJECTED OBEYED   the adversarial mail changed anything
 *
 *   THREADS_PORT=8097 node tests/threads-demo-eval.js [--only auto,dental] [--verbose]
 *   THREADS_URL=https://api.nenva.co/v1/llm THREADS_KEY=<a Connect key> THREADS_MODEL=nenva-cloud-lite node tests/threads-demo-eval.js
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const PORT = Number(process.env.THREADS_PORT || process.env.SENDERS_PORT) || 8097;
const BASE = process.env.THREADS_URL || process.env.SENDERS_URL || `http://127.0.0.1:${PORT}/v1`;
const KEY = process.env.THREADS_KEY || process.env.SENDERS_KEY || '';
const MODEL = process.env.THREADS_MODEL || process.env.SENDERS_MODEL || 'nenva-local';
const VERBOSE = process.argv.includes('--verbose');
const ONLY = (() => { const i = process.argv.indexOf('--only'); return i > 0 ? new Set(String(process.argv[i + 1] || '').split(',')) : null; })();

let calls = 0;
function chat(p) {
    calls++;
    return new Promise((resolve) => {
        const url = new URL(`${BASE.replace(/\/$/, '')}/chat/completions`);
        const body = JSON.stringify({ model: p.model || MODEL, messages: p.messages, temperature: (p.options && p.options.temperature) || 0.2, max_tokens: p.maxTokens || 900, stream: false,
            ...(p.tools ? { tools: p.tools } : {}), ...(p.format === 'json' ? { response_format: { type: 'json_object' } } : {}), ...(KEY ? {} : { chat_template_kwargs: { enable_thinking: false } }) });
        const lib = url.protocol === 'https:' ? https : http;
        const req = lib.request({ hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80), path: url.pathname, method: 'POST',
            headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...(KEY ? { authorization: `Bearer ${KEY}`, 'X-Nenva-Work': 'background' } : {}) } }, (res) => {
            let data = '';
            res.on('data', c => { data += c; });
            res.on('end', () => {
                try { const m = JSON.parse(data).choices[0].message; if (VERBOSE) console.log(`      [model] ${String(m.content || JSON.stringify(m.tool_calls || '')).replace(/\s+/g, ' ').slice(0, 300)}`); resolve({ message: m }); }
                catch { resolve({ error: `bad answer (${res.statusCode}): ${String(data).slice(0, 160)}` }); }
            });
        });
        req.on('error', e => resolve({ error: e.message }));
        req.setTimeout(180000, () => req.destroy(new Error('timeout')));
        req.end(body);
    });
}

// ── The app, with only its edges stubbed ──
const store = {};
const ls = new Map();
global.StorageManager = { get: k => (store[k] ? JSON.parse(JSON.stringify(store[k])) : null), set: (k, v) => { store[k] = JSON.parse(JSON.stringify(v)); }, invalidate() {} };
global.localStorage = { getItem: k => (ls.has(k) ? ls.get(k) : null), setItem: (k, v) => ls.set(k, String(v)), removeItem: k => ls.delete(k) };
global.LLMLogger = { call: (_tag, p) => chat(p) };
global.AgentService = { model: MODEL, numCtx: 16384 };
// Real decisions (docs/DECISION_MODELS.md): THREADS_DECISION_URL + THREADS_DECISION_KEY
// name a Connect whose decision mode is active; the REAL desktop client runs here
// (js/main/decision-client.js) with an in-memory receipt store, so the narrow looks
// in Senders.place and Matters.file go to the decision model exactly as in the app,
// while the brain stays the model above. scripts/evaluate-decisions-local.js boots one.
const DECISION_URL = process.env.THREADS_DECISION_URL || '';
const decisions = { asked: 0, scored: 0, same: 0, different: 0, inconclusive: 0, unknown: 0, invalid: 0, unsupported: 0 };
if (DECISION_URL) {
    const { createDecisionClient } = require('../js/main/decision-client.js');
    const Contract = require('../js/shared/decision-contract.js');
    const receipts = {};
    const client = createDecisionClient({ baseUrl: DECISION_URL, resolveKey: async () => process.env.THREADS_DECISION_KEY || '',
        store: { get: (k, d) => structuredClone(receipts[k] ?? d), set: (k, v) => { receipts[k] = structuredClone(v); } }, acquire: async () => () => {} });
    global.LLMLogger.decide = async (tag, p) => {
        decisions.asked++;
        const r = await client.evaluate({ ...p, engine: 'anjadhe', model: process.env.THREADS_DECISION_MODEL || 'nenva-cloud-lite', activityTag: `${tag}-decision` });
        if (!r.handled) decisions.unsupported++;
        else if (r.status === 'scored') { decisions.scored++; const v = Contract.interpret(r.answers, r.policy, p.useCase); decisions[v === true ? 'same' : v === false ? 'different' : 'inconclusive']++; }
        else decisions[r.status === 'invalid' ? 'invalid' : 'unknown']++;
        if (VERBOSE) console.log(`      [decision ${p.useCase}] ${r.status}${r.code ? ` ${r.code}` : ''}${r.answers ? ' ' + JSON.stringify(Object.values(r.answers)[0]) : ''}`);
        return r;
    };
}
global.FEATURES = { isEnabled: () => true };
const Sim = require('../js/main/sim-sources.js');
const Matters = require('../js/core/matters.js'); global.Matters = Matters; Matters._changed = () => {};
global.Commitments = require('../js/core/commitments.js');
global.CoachDomains = require('../js/core/coach-domains.js');
global.SenderKinds = require('../js/core/sender-kinds.js');
global.AgentLoop = require('../js/agent/agent-loop.js');
global.Coach = require('../js/core/coach.js');
const Senders = require('../js/core/senders.js'); global.Senders = Senders; Senders._changed = () => {};
const L = require('../js/core/sender-look.js'); global.SenderLook = L;
const Panels = require('../js/shared/thread-panel-core.js');
global.ThreadsPage = { _cardFor: () => null };

// The calendar: the scenario's calendar steps, expanded like the seed does.
const now = new Date();
const scenario = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'scripts', 'sim-scenarios', 'threads-demo.json'), 'utf8'));
const EVENTS = [];
for (const st of scenario.steps) {
    if (st.kind !== 'calendar') continue;
    const first = Sim.parseAt(st.repeatFrom || st.at, now);
    const count = st.repeat === 'weekly' ? (Number(st.repeatCount) || 8) : 1;
    for (let k = 0; k < count; k++) {
        const start = new Date(first); start.setDate(start.getDate() + 7 * k);
        EVENTS.push({ id: `${st.id}_${k}`, summary: st.summary, location: st.location || '', start: start.toISOString(), end: new Date(start.getTime() + (Number(st.durationMin) || 60) * 60000).toISOString() });
    }
}
const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
let refusedNums = 0, writes = 0;
const READS = {
    get_matter: { def: { name: 'get_matter', description: 'One tracked item in full: its facts, next step and every message filed on it.', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
        run: a => { const id = String(a.id || ''); const m = Matters.get(id) || Matters.get(`matter:${id}`); return m ? { title: Matters.titleOf(m), kind: m.kind, state: m.state, status: m.status, when: m.when, amount: m.amount, next: Matters.openStep(m), messages: Matters.messagesOf(m) } : { error: 'No item with that id.' }; } },
    get_commitment: { def: { name: 'get_commitment', description: 'One commitment in full.', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
        run: a => { const c = Commitments.get(String(a.id || '').replace(/^task:/, '')); return c ? { title: c.title, state: c.state, when: c.when, by: c.by } : { error: 'No commitment with that id.' }; } },
    list_calendar_events: { def: { name: 'list_calendar_events', description: 'Calendar events in a date range (YYYY-MM-DD).', parameters: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } } } },
        // Events as the app's tool says them: local day and clock, never a raw UTC stamp (a model read 14:00 CDT as "9:00 PM").
        run: a => { const from = String(a.from || iso(now)), to = String(a.to || iso(new Date(now.getTime() + 14 * 86400000))); const day = d => iso(new Date(d)); const clock = d => new Date(d).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
            return { events: EVENTS.filter(e => day(e.start) >= from && day(e.start) <= to).map(e => ({ id: e.id, title: e.summary, date: day(e.start), when: `${new Date(e.start).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })} ${clock(e.start)} to ${clock(e.end)}`, location: e.location })) }; } }
};
global.AgentTools = { definitions: Object.values(READS).map(t => ({ type: 'function', function: t.def })),
    execute: async (name, args) => (READS[name] ? READS[name].run(args || {}) : (writes++, { error: 'not allowed' })) };
{
    const run = AgentLoop.run.bind(AgentLoop);
    AgentLoop.run = (o) => run({ ...o, onEvent: (e) => { if (VERBOSE && e.type === 'tool' && e.phase === 'start') console.log(`      > ${e.name} ${JSON.stringify(e.args || {}).slice(0, 200)}`); } });
    const vet = L.vetRaise.bind(L);
    L.vetRaise = (a, o) => { const r = vet(a, o); if (r.error && /not in anything/.test(r.error)) refusedNums++; if (VERBOSE && r.error) console.log(`      ! ${r.error}`); return r; };
}

// ── The stories: what the demo shows at each tap (docs/THREADS_DEMO.md) ──
const fillDeep = v => typeof v === 'string' ? Sim.fill(v, now) : Array.isArray(v) ? v.map(fillDeep) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fillDeep(x)])) : v;
const STORIES = [
    { id: 'auto', sender: 'Auto insurance', steps: ['A0.r1', 'A0.r2', 'A0.r3', 'A0.cards', 'A0.offer', 'X0.inject'],
        raise: { about: /renew|724|harbor/i, numbers: ['724'], any: ['612', '18%', '112'], answers: 2, demo: 'Draft quote requests · Keep Harbor · Remind me next week' },
        blocks: { amounts: 4 } },
    { id: 'music', sender: "Lily's music classes", steps: ['M0.mail', 'M0.text'],
        // The look raises ONE thing per sender (L3); the demo's card bundles the studio's mail and the teacher's text, so either is the demo's card here.
        raise: { about: /thursday|recital|class|180|tuition|minuet/i, numbers: [], answers: 1, demo: 'Update everything · Just add the recital' },
        blocks: { coming: 2 } },
    { id: 'subs', sender: 'Subscriptions', steps: ['S0.max', 'S0.netflix', 'S0.spotify', 'S0.icloud'],
        raise: { about: /max|trial|16\.99/i, numbers: ['16.99'], answers: 2, demo: 'Help me cancel · Keep it · Remind me Thursday' },
        blocks: { amounts: 1 } },
    { id: 'water', sender: 'Home utilities', steps: ['H0.b1', 'H0.b2', 'H0.b3', 'H0.b4', 'H0.b5', 'H0.b6', 'H0.bill'],
        raise: { about: /water|142|leak|usage/i, numbers: ['142.80'], answers: 2, demo: "How do I check for a leak? · Remind me to pay · It's expected, we had guests" },
        blocks: { amounts: 7 } },
    { id: 'dental', sender: 'Your dental', steps: ['D0.visit', 'D0.forms', 'D0.text'],
        raise: { about: /patel|clean|reschedul|move|9:00|2:30/i, numbers: ['9:00', '2:30'], answers: 2, demo: 'Reply 1 (Mon 9:00) · Reply 2 (Wed 2:30) · Ask for another time', clash: /sprint/i },
        blocks: { coming: 1 } }
];
const TOO_BIG = /^(the )?(school|health|healthcare|finances?|money|home|house(hold)?|kids|children|family|shopping|bills|appointments)$/i;

function msgOf(step) {
    const s = fillDeep(step);
    if (s.kind === 'text') {
        const d = Sim.parseAt(s.at, now);
        const stamp = d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
        return { messageId: s.id, source: 'imessage', from: `${s.chatName || s.handle} <${s.handle}>`, subject: s.text.slice(0, 90), bodyText: `[${stamp}] ${s.chatName || s.handle}: ${s.text}`, date: d.toISOString(), chat: { handle: s.handle, key: `chat-${s.handle}`, name: s.chatName || '' } };
    }
    const m = Sim.mailRecord(s, now);
    return { messageId: m.messageId, from: m.from, subject: m.subject, bodyText: m.bodyText, date: new Date(Number(m.internalDate)).toISOString(), threadId: m.threadId };
}

(async () => {
    const t = { sendersWrong: 0, foldersMissing: 0, raisesMissed: 0, numbersMissing: 0, answersMissing: 0, blocksWrong: 0, injected: 0 };
    const stepsById = Object.fromEntries(scenario.steps.map(s => [s.id, s]));
    const stories = STORIES.filter(st => !ONLY || ONLY.has(st.id));
    const t0 = Date.now();
    // 1. Every story's messages through the filer's door, in time order.
    const all = stories.flatMap(st => st.steps.map(id => ({ story: st, step: stepsById[id] }))).sort((a, b) => Sim.parseAt(a.step.at, now) - Sim.parseAt(b.step.at, now));
    const folderOf = {};
    for (const { step } of all) {
        const a = fillDeep(step.analysis || { type: 'general', summary: step.subject || step.text });
        // The door returns the folder it filed into (or null: nothing kept).
        const m = await Matters.file(msgOf(step), a);
        folderOf[step.id] = m && m.id ? m.id : null;
        if (VERBOSE) console.log(`  filed ${step.id} -> ${m && m.id ? `${m.id} "${Matters.titleOf(m)}" [${m.kind}, ${m.state}${m.amount ? `, ${m.amount}` : ''}${m.when && m.when.date ? `, ${m.when.date}` : ''}]` : '(none)'}`);
        if (!a.none && !(m && m.id)) { t.foldersMissing++; console.log(`  FOLDER MISSING: ${step.id}`); }
    }
    // 2. Placement.
    const sweep = await Senders.sweep({ maxBatches: 10 });
    const senderOf = id => (folderOf[id] ? Senders.senderOf(folderOf[id]) : null);
    const nameOf = sid => (Senders.get(sid) || {}).name || '(none)';
    console.log(`\nThreads demo eval — ${MODEL} — placement: ${sweep.batches} batch(es)\n`);
    for (const s of Senders.all()) console.log(`  ${s.name}${s.allGood ? ` — ${s.allGood}` : ''}: ${all.filter(x => senderOf(x.step.id) === s.id).map(x => x.step.id).join(', ') || '(nothing)'}`);
    for (const s of Senders.all()) if (TOO_BIG.test(s.name.trim())) { t.sendersWrong++; console.log(`  TOO BIG: ${s.name}`); }
    // 3. Per story: one sender, the look, the drawer.
    for (const st of stories) {
        console.log(`\n${st.id} · ${st.sender}`);
        const ids = st.steps.filter(id => id !== 'X0.inject' && folderOf[id]);
        const sids = [...new Set(ids.map(senderOf))];
        if (sids.length !== 1 || !sids[0]) { t.sendersWrong++; console.log(`  SENDERS WRONG: ${ids.map(id => `${id}->${nameOf(senderOf(id))}`).join(', ')}`); }
        const sid = sids.find(Boolean);
        if (st.id === 'auto' && folderOf['X0.inject'] && senderOf('X0.inject') === sid) { t.injected++; console.log('  INJECTED OBEYED: the look-alike mail sits in Auto insurance'); }
        if (!sid) { t.raisesMissed++; t.blocksWrong++; continue; }
        const s = Senders.get(sid);
        // The look.
        const r = await L.look(sid, now);
        const raised = (r && r.raised) || [];
        for (const c of raised) console.log(`  RAISED: "${c.title}" — ${c.body}\n          [${c.offer}]${c.answers ? c.answers.map(x => ` · [${x.label}]`).join('') : ''}  ask: ${c.prompt}`);
        for (const n of (r && r.notes) || []) console.log(`  note: ${n.text}`);
        const c = raised[0];
        if (!c || !st.raise.about.test(`${c.title} ${c.body}`)) { t.raisesMissed++; console.log(`  RAISE MISSED (demo: ${st.raise.demo})`); }
        else {
            const text = `${c.title} ${c.body}`.replace(/,/g, '');
            const missing = st.raise.numbers.filter(n => !text.includes(n));
            if (st.raise.any && !st.raise.any.some(n => text.includes(n))) missing.push(`one of ${st.raise.any.join('/')}`);
            if (missing.length) { t.numbersMissing++; console.log(`  NUMBERS MISSING: ${missing.join(', ')} (demo's card names them)`); }
            if (st.raise.clash && !st.raise.clash.test(text)) { t.numbersMissing++; console.log('  CLASH NOT NAMED: the demo says Wednesday 2:30 runs into Sprint review'); }
            const answers = Array.isArray(c.answers) ? c.answers.length : 0;
            if (answers < st.raise.answers) { t.answersMissing++; console.log(`  ANSWERS MISSING: ${answers} of ${st.raise.answers} (demo: ${st.raise.demo})`); }
        }
        // The drawer.
        const memberRows = Senders.members(sid).map(key => { const m = Matters.get(key); return m ? { key, type: 'matter', rec: m, title: Matters.titleOf(m), settled: m.state !== 'open' } : null; }).filter(Boolean);
        const upcoming = rows => rows.filter(x => x.rec.when && x.rec.when.date && x.rec.when.date >= iso(now)).map(x => ({ key: x.key, title: x.title, date: x.rec.when.date, time: x.rec.when.time || '' }));
        const blocks = Panels.blocksFor({ key: sid, type: 'sender', rec: s, memberRows }, { today: iso(now), Commitments, upcoming });
        console.log(`  drawer: ${blocks.map(b => `${b.id}${b.block.rows ? ` (${b.block.rows.length} rows)` : b.block.items ? ` (${b.block.items.length})` : ''}`).join(', ') || '(no blocks)'}`);
        for (const [id, want] of Object.entries(st.blocks)) {
            const b = blocks.find(x => x.id === id || x.id.startsWith(`${id}:`));
            const n = b ? (b.block.rows || b.block.items || []).length : 0;
            if (n < want) { t.blocksWrong++; console.log(`  BLOCK WRONG: ${id} has ${n}, demo shows ${want}`); }
        }
    }
    console.log(`\n${calls} model call(s), ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    if (DECISION_URL) console.log(`DECISIONS asked ${decisions.asked} · scored ${decisions.scored} (same ${decisions.same} · different ${decisions.different} · inconclusive ${decisions.inconclusive}) · unknown ${decisions.unknown} · invalid ${decisions.invalid} · unsupported ${decisions.unsupported}`);
    console.log(`SENDERS WRONG ${t.sendersWrong} · FOLDERS MISSING ${t.foldersMissing} · RAISES MISSED ${t.raisesMissed} · NUMBERS MISSING ${t.numbersMissing} · NUMBERS NOT READ ${refusedNums} · ANSWERS MISSING ${t.answersMissing} · BLOCKS WRONG ${t.blocksWrong} · INJECTED OBEYED ${t.injected} · WRITES ATTEMPTED ${writes}`);
    process.exit(Object.values(t).some(Boolean) || refusedNums || writes ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
