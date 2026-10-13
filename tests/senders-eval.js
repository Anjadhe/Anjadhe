#!/usr/bin/env node
/**
 * Senders eval: the gate for the placement prompt (docs/SENDERS.md M1).
 * Runs the app's OWN sweep (Senders.sweep: eligible, the prompt, vet, apply,
 * batches that see the senders the batch before made) against a model; only
 * the transport and the stores are stubbed. Fixtures are SYNTHETIC.
 *
 * The numbers (all should be zero):
 *   SPLIT           a pair that is one thing in the person's life landed in two senders
 *   WRONGLY JOINED  a pair that is two things landed in one sender
 *   TOO BIG         a sender named after a whole area of life (School, Health...)
 *   UNPLACED        an item with no sender after the sweep
 *
 * Local:
 *   ~/.nenva_llamacpp/engine/llama-server -m <model>.gguf --port 8097 -c 16384 --jinja
 *   SENDERS_PORT=8097 SENDERS_MODEL=nenva-local node tests/senders-eval.js [--verbose]
 * Any OpenAI-compatible endpoint (nenva cloud lite, metered as background work):
 *   SENDERS_URL=https://api.nenva.co/v1/llm SENDERS_KEY=<a Connect key> SENDERS_MODEL=nenva-cloud-lite node tests/senders-eval.js
 */
const http = require('http');
const https = require('https');
const PORT = Number(process.env.SENDERS_PORT) || 8097;
const BASE = process.env.SENDERS_URL || `http://127.0.0.1:${PORT}/v1`;
const KEY = process.env.SENDERS_KEY || '';
const MODEL = process.env.SENDERS_MODEL || 'nenva-local';
const VERBOSE = process.argv.includes('--verbose');

let blob = null;
global.StorageManager = { get: () => blob, set: (_k, v) => { blob = JSON.parse(JSON.stringify(v)); } };
global.AgentService = { model: MODEL, numCtx: 16384 };
let calls = 0;
global.LLMLogger = {
    call: (tag, p) => new Promise((resolve) => {
        calls++;
        const url = new URL(`${BASE.replace(/\/$/, '')}/chat/completions`);
        const body = JSON.stringify({ model: p.model, messages: p.messages, temperature: (p.options && p.options.temperature) || 0.1, max_tokens: p.maxTokens || 600, stream: false,
            ...(p.format === 'json' ? { response_format: { type: 'json_object' } } : {}),
            ...(KEY ? {} : { chat_template_kwargs: { enable_thinking: false } }) });
        const lib = url.protocol === 'https:' ? https : http;
        const req = lib.request({ hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80), path: url.pathname, method: 'POST',
            headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...(KEY ? { authorization: `Bearer ${KEY}`, 'X-Nenva-Work': 'background' } : {}) } }, (res) => {
            let data = '';
            res.on('data', c => { data += c; });
            res.on('end', () => {
                try { const content = JSON.parse(data).choices[0].message.content; if (VERBOSE) console.log(`    [${tag}] ${String(content).replace(/\s+/g, ' ').slice(0, 600)}`); resolve({ message: { content } }); }
                catch { resolve({ error: `bad answer: ${String(data).slice(0, 160)}` }); }
            });
        });
        req.on('error', e => resolve({ error: e.message }));
        req.end(body);
    })
};
global.SenderKinds = require('../js/core/sender-kinds.js');
const Senders = require('../js/core/senders.js');
Senders._changed = () => {};

const day = n => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
const ago = h => new Date(Date.now() - h * 3600000).toISOString();
const M = (id, kind, title, status, from, summary, when = null, address = null) => ({ id: `matter:${id}`, kind, state: 'open', title, status, when: when ? { date: when } : null,
    updatedAt: ago(Number(id.slice(1))), sources: [{ id, kind: 'email', at: ago(Number(id.slice(1))), from, summary, ...(address ? { address } : {}) }] });
const C = (id, title, extra = {}) => ({ id, title, state: 'open', updatedAt: ago(5), ...extra });

const MATTERS = [
    M('m1', 'bill', 'GEICO auto policy renewal', 'Renews soon', 'GEICO', 'Your auto policy renews next month; review your coverage', day(23)),
    M('m2', 'other', 'New GEICO ID cards', 'Ready to print', 'GEICO', 'Your new auto insurance ID cards are ready'),
    M('m3', 'bill', 'City Water bill', 'Due soon', 'City of Palo Alto Utilities', 'Your water bill is ready', day(4)),
    M('m4', 'bill', 'PG&E electric bill', 'Due soon', 'PG&E', 'Your energy statement is ready', day(10)),
    M('m5', 'appointment', 'Dental cleaning with Dr. Lee', 'Confirmed', 'Lee Family Dentistry', 'Reminder: your cleaning appointment', day(6)),
    M('m6', 'appointment', "Maya's dental checkup", 'Confirmed', 'Bright Smiles Pediatric Dentistry', "Maya's six-month checkup is booked", day(12)),
    M('m7', 'appointment', "Maya's annual physical", 'Bring the sports form', 'Palo Alto Pediatrics', "Maya's well-child visit; bring the school sports physical form", day(15)),
    M('m8', 'other', 'Field trip permission slip', 'Sign by Friday', 'Lincoln Elementary', 'Permission slip for the 3rd grade trip to the science museum', day(3)),
    M('m9', 'bill', 'School lunch account low', 'Add funds', 'Lincoln Elementary Nutrition', "Maya's lunch account balance is low, please add funds"),
    M('m10', 'appointment', 'Back-to-school night', 'Thursday evening', 'Lincoln Elementary', 'Join us for back-to-school night', day(6)),
    M('m11', 'bill', 'Harmony Music School tuition', 'Due soon', 'Harmony Music School', "October tuition invoice for Maya's piano lessons", day(5)),
    M('m12', 'appointment', 'Winter piano recital', 'Save the date', 'Harmony Music School', 'Winter recital for all piano students', day(60)),
    M('m13', 'order', 'Running shoes', 'Shipped', 'Amazon', 'Your order of running shoes has shipped'),
    M('m14', 'appointment', 'Dishwasher repair visit', 'Technician coming', 'Sears Home Services', 'Your dishwasher repair is scheduled', day(2)),
    M('m15', 'bill', 'Community garden plot renewal', 'Renew by month end', 'Mitchell Park Community Garden', 'Renew your garden plot for next season'),
    M('m16', 'other', 'Garden watering rota', 'Your week is next', 'Mitchell Park Community Garden', 'The watering schedule for plot holders'),
    M('m17', 'bill', 'Chase Sapphire statement', 'Payment due', 'Chase', 'Your credit card statement is ready', day(9)),
    M('m18', 'subscription', 'Netflix price change', 'Goes up next month', 'Netflix', 'Your Netflix plan price is changing'),
    M('m19', 'subscription', 'Spotify renewal', 'Renews soon', 'Spotify', 'Your Spotify Premium renews soon', day(8)),
    // Two companies writing to one mailbox about their own developer accounts (the 2026-10-12 miss: a cloud console notice landed in the AI vendor's thread).
    M('m20', 'other', 'API key "for-claude-code" expiring', 'Rotate before it expires', 'Anthropic', 'Your API key for-claude-code expires soon; create a new key and rotate clients', day(20), 'support@anthropic.com'),
    M('m21', 'other', 'Claude API credits purchase', 'Receipt', 'Anthropic', 'Thanks for your $20 purchase of API credits', null, 'billing@anthropic.com'),
    M('m22', 'other', 'Mark AI agent OAuth clients as agentic', 'Required by Nov 11 or Workspace MCP servers reject requests', 'The Google Workspace Team', "OAuth clients used by AI agents in project 'anjadheapp' must be marked as agentic", day(30), 'workspace-noreply@google.com')
];
const COMMITMENTS = [
    C('c1', 'Lift weights', { repeat: { rule: 'weekly' }, domain: 'fitness' }),
    C('c2', 'Sleep 8 hours a night', { outcome: true, shape: 'goal', domain: 'health' }),
    C('c3', 'Practice piano with Maya', { repeat: { rule: 'daily' } }),
    C('c4', 'Renew passport', { by: day(40) })
];
const k = id => (id.startsWith('c') ? `task:${id}` : `matter:${id}`);
const TOGETHER = [['m1', 'm2'], ['m3', 'm4'], ['m8', 'm10'], ['m11', 'm12'], ['m11', 'c3'], ['m15', 'm16'], ['m18', 'm19'], ['m20', 'm21']];
const APART = [['m5', 'm6'], ['m6', 'm7'], ['m8', 'm9'], ['m1', 'm3'], ['m17', 'm18'], ['m13', 'm15'], ['c1', 'c2'], ['m11', 'm8'], ['m14', 'm3'], ['c4', 'm1'], ['m20', 'm22'], ['m21', 'm22']];
const TOO_BIG = /^(the )?(school|health|healthcare|finances?|money|home|house(hold)?|kids|children|family|shopping|bills|appointments)$/i;

(async () => {
    global.Matters = { all: () => MATTERS, forAmbient: () => MATTERS, get: id => MATTERS.find(m => m.id === id) || null };
    global.Commitments = { all: () => COMMITMENTS, get: id => COMMITMENTS.find(c => c.id === id) || null };
    const t0 = Date.now();
    const out = await Senders.sweep({ maxBatches: 10 });
    const of = id => Senders.senderOf(k(id));
    const name = id => (Senders.get(of(id)) || {}).name || '(none)';
    const ids = [...MATTERS.map(m => m.id.slice(7)), ...COMMITMENTS.map(c => c.id)];
    console.log(`Senders eval — ${MODEL} — ${calls} call(s), ${out.batches} batch(es), ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
    for (const s of Senders.all()) {
        const members = ids.filter(id => of(id) === s.id);
        console.log(`  ${s.name}${s.allGood ? ` — ${s.allGood}` : ''}\n      ${members.join(', ')}`);
    }
    const split = TOGETHER.filter(([a, b]) => !of(a) || of(a) !== of(b));
    const joined = APART.filter(([a, b]) => of(a) && of(a) === of(b));
    const big = Senders.all().filter(s => TOO_BIG.test(s.name.trim()));
    const unplaced = ids.filter(id => !of(id));
    console.log('');
    split.forEach(([a, b]) => console.log(`  SPLIT: ${a} (${name(a)}) / ${b} (${name(b)})`));
    joined.forEach(([a, b]) => console.log(`  WRONGLY JOINED: ${a} + ${b} in ${name(a)}`));
    big.forEach(s => console.log(`  TOO BIG: ${s.name}`));
    if (unplaced.length) console.log(`  UNPLACED: ${unplaced.join(', ')}`);
    console.log(`\nSPLIT ${split.length} · WRONGLY JOINED ${joined.length} · TOO BIG ${big.length} · UNPLACED ${unplaced.length} · ${Senders.all().length} senders for ${ids.length} items`);
    process.exit(split.length + joined.length + big.length + unplaced.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
