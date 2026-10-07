#!/usr/bin/env node
/**
 * Now eval — docs/NOW.md step 5: the one chat judge (ThingCapture) against a
 * real model. For each case the person says one thing in a card's chat and
 * the eval prints what happened to the CARD and the RECORD; the number that
 * matters is CARDS LEFT UP AFTER "IGNORE" (and its mirror: a card set aside
 * on a question). The gate for any change to the judge's prompts.
 *
 * Runs the app's own path (ThingCapture.beforeReply → MatterCapture.vet /
 * OccurrenceCapture.vet → Matters.foldOwn / Commitments.report / resolve →
 * Raises.settleThing) against a local OpenAI-compatible server; only the
 * model transport, the store and the shell's card are stubbed.
 *
 * Start a server first, e.g.:
 *   ~/.nenva_llamacpp/engine/llama-server -m <model>.gguf --port 8097 -c 8192 --jinja
 * then:
 *   NOW_PORT=8097 NOW_MODEL=nenva-local node tests/now-eval.js [--only c1,c4] [--verbose]
 */
const http = require('http');
const PORT = Number(process.env.NOW_PORT || process.env.MATTERS_PORT) || 8097;
const HOST = process.env.NOW_HOST || '127.0.0.1';
const MODEL = process.env.NOW_MODEL || process.env.MATTERS_MODEL || 'nenva-local';
const VERBOSE = process.argv.includes('--verbose');
const ONLY = (() => { const i = process.argv.indexOf('--only'); return i > 0 ? new Set(String(process.argv[i + 1] || '').split(',')) : null; })();

const store = {};
global.StorageManager = { get: k => store[k] ? JSON.parse(JSON.stringify(store[k])) : null, set: (k, v) => { store[k] = JSON.parse(JSON.stringify(v)); } };
global.AgentService = { model: MODEL, numCtx: 8192, conversations: [], _persistConversation() {}, _syncActiveConversation() {}, _streamingState: new Map() };
global.FEATURES = { isEnabled: () => true };
global.LLMLogger = {
    call: (tag, p) => new Promise((resolve) => {
        const body = JSON.stringify({ model: p.model, messages: p.messages, temperature: (p.options && p.options.temperature) || 0.1, max_tokens: p.maxTokens || 400,
            stream: false, ...(p.format === 'json' ? { response_format: { type: 'json_object' } } : {}), chat_template_kwargs: { enable_thinking: false } });
        const req = http.request({ host: HOST, port: PORT, path: '/v1/chat/completions', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => {
            let data = '';
            res.on('data', c => { data += c; });
            res.on('end', () => {
                try { const j = JSON.parse(data); const content = j.choices[0].message.content; if (VERBOSE) console.log(`    [${tag}] ${String(content).replace(/\s+/g, ' ').slice(0, 300)}`); resolve({ message: { content } }); }
                catch (e) { resolve({ error: `bad answer: ${String(data).slice(0, 120)}` }); }
            });
        });
        req.on('error', e => resolve({ error: e.message }));
        req.end(body);
    })
};
const Matters = require('../js/core/matters.js'); global.Matters = Matters; Matters._changed = () => {};
const Commitments = require('../js/core/commitments.js'); global.Commitments = Commitments;
global.MatterCapture = require('../js/agent/matter-capture.js');
global.OccurrenceCapture = require('../js/agent/occurrence-capture.js');
const Raises = require('../js/core/raises.js'); global.Raises = Raises;
const T = require('../js/agent/thing-capture.js');

const pad = n => String(n).padStart(2, '0');
const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const inDays = n => { const d = new Date(); d.setDate(d.getDate() + n); return d; };
const today = iso(new Date());

// A minimal Commitments store: the bridge is not started, the door works.
Commitments._inited = true;
Commitments.project = () => {};
Commitments._changed = () => {};

// The shell: a card per thing, whose "Ignore" / "Show later" button runs through Raises.
const cards = new Map();
global.SimpleExperience = {
    LATER_MS: 4 * 3600000,
    cardForThing: t => cards.get(t) || null,
    letGoFromChat: (thing, forGood, { quote } = {}) => {
        const c = cards.get(thing);
        if (!c) return { done: true, note: 'gone' };
        if (c.matter && forGood) Matters.ignore(c.matter);
        Raises.settleThing(thing, forGood ? (c.matter ? 'ignore' : 'done') : 'later', { by: 'chat', quote, until: forGood ? null : 4 * 3600000 });
        return { done: true, title: c.title, how: forGood ? 'for good' : 'for now' };
    }
};

function makeMatter() {
    const m = { id: 'matter:bill1', kind: 'bill', state: 'open', title: 'Water bill', status: `$82 due ${iso(inDays(8))}`, amount: '$82', when: { date: iso(inDays(8)), time: null },
        next: { what: 'Pay the water bill', state: 'open', how: 'link', url: 'https://example.com/pay', askedAt: new Date().toISOString() },
        ids: [], sources: [{ id: 'msg1', kind: 'email', at: new Date(Date.now() - 86400000).toISOString(), from: 'City Water', summary: 'Your water bill of $82 is due' }],
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    store.matters = { version: Matters.VERSION, matters: { [m.id]: m }, aliases: {} };
    Matters._data = null;
    return m;
}
function makeOnce() {
    const c = { ...Commitments.blank('t1', new Date(Date.now() - 10 * 86400000).toISOString()), title: 'Send the roadmap deck to leadership', state: 'open', when: { date: iso(inDays(-2)), time: null, end: null } };
    store[Commitments.KEY] = { items: [c], ledger: [] };
    Commitments._data = null;
    return c;
}
function makeWeekly() {
    const dow = new Date().getDay();
    const c = { ...Commitments.blank('w1', new Date(Date.now() - 60 * 86400000).toISOString()), title: 'Morning run', state: 'open', when: { date: iso(inDays(-14)), time: '07:00', end: null }, repeat: { rule: 'weekly', days: [dow] } };
    store[Commitments.KEY] = { items: [c], ledger: [] };
    Commitments._data = null;
    return c;
}
function raise(thing, card) {
    store.raises = null; Raises._data = null;
    cards.clear(); cards.set(thing, { thing, ...card });
    Raises._save(Raises.reconcile(Raises.blank(), [{ thing, rev: 'a', producer: 'now', content: { kind: 'decide', title: card.title, body: card.body || '' } }]).state);
}

const CASES = [
    { id: 'c1', thing: 'matter:bill1', setup: () => { makeMatter(); raise('matter:bill1', { title: 'Water bill', body: '$82 due in 8 days', matter: 'matter:bill1' }); }, say: 'just ignore it', want: { card: 'gone' } },
    { id: 'c2', thing: 'matter:bill1', setup: () => { makeMatter(); raise('matter:bill1', { title: 'Water bill', body: '$82 due in 8 days', matter: 'matter:bill1' }); }, say: 'I paid it yesterday', want: { card: 'gone', matter: 'done' } },
    { id: 'c3', thing: 'matter:bill1', setup: () => { makeMatter(); raise('matter:bill1', { title: 'Water bill', body: '$82 due in 8 days', matter: 'matter:bill1' }); }, say: 'remind me tomorrow', want: { card: 'later' } },
    { id: 'c4', thing: 'matter:bill1', setup: () => { makeMatter(); raise('matter:bill1', { title: 'Water bill', body: '$82 due in 8 days', matter: 'matter:bill1' }); }, say: 'what is this about?', want: { card: 'keep' } },
    { id: 'c5', thing: 'matter:bill1', setup: () => { makeMatter(); raise('matter:bill1', { title: 'Water bill', body: '$82 due in 8 days', matter: 'matter:bill1' }); }, say: `they moved the due date to the ${inDays(14).getDate()}th`, want: { card: 'keep', matterWhen: iso(inDays(14)) } },
    { id: 'c6', thing: 'task:t1', setup: () => { makeOnce(); raise('task:t1', { title: 'Send the roadmap deck to leadership', body: 'Was due 2 days ago' }); }, say: 'cancel it, not needed any more', want: { card: 'gone', commitment: 'dropped' } },
    { id: 'c7', thing: 'task:t1', setup: () => { makeOnce(); raise('task:t1', { title: 'Send the roadmap deck to leadership', body: 'Was due 2 days ago' }); }, say: 'sent it this morning', want: { card: 'gone', commitment: 'done' } },
    { id: 'c8', thing: 'task:w1', setup: () => { makeWeekly(); raise('task:w1', { title: 'Morning run', body: 'How did it go?' }); }, say: 'did it last night, knee was a bit sore', want: { card: 'gone', day: 'done' } },
    { id: 'c9', thing: 'task:w1', setup: () => { makeWeekly(); raise('task:w1', { title: 'Morning run', body: 'How did it go?' }); }, say: 'how many weeks have I kept this up?', want: { card: 'keep' } },
    { id: 'c10', thing: 'trip:sea', setup: () => { raise('trip:sea', { title: 'Seattle trip', body: 'Flights Thursday, hotel Thursday to Sunday' }); }, say: 'stop showing me this', want: { card: 'gone' } }
];

(async () => {
    let wrong = 0, leftUp = 0, wronglyGone = 0;
    for (const c of CASES) {
        if (ONLY && !ONLY.has(c.id)) continue;
        c.setup();
        const conv = { id: `conv_${c.id}`, todayKey: c.thing, messages: [] };
        const out = await T.beforeReply({ conv, userText: c.say });
        const r = Raises.get(c.thing);
        const got = { card: r.state === 'settled' ? 'gone' : r.state === 'later' ? 'later' : 'keep' };
        const m = Matters.get('matter:bill1');
        if (c.want.matter) got.matter = m && m.state;
        if (c.want.matterWhen) got.matterWhen = m && m.when && m.when.date;
        if (c.want.commitment) got.commitment = Commitments.get('t1') && Commitments.get('t1').state;
        if (c.want.day) { const w = Commitments.get('w1'); const days = Commitments.recentDays(w, today); got.day = w.history && w.history[days[0]] || null; }
        const ok = Object.keys(c.want).every(k => got[k] === c.want[k]);
        if (!ok) wrong++;
        if (c.want.card === 'gone' && got.card !== 'gone') leftUp++;
        if (c.want.card === 'keep' && got.card !== 'keep') wronglyGone++;
        console.log(`${ok ? 'ok  ' : 'FAIL'} ${c.id} "${c.say}" → ${JSON.stringify(got)}${ok ? '' : ` wanted ${JSON.stringify(c.want)}`}${out && out.line ? `\n       ${out.line}` : ''}`);
    }
    console.log(`\nCARDS LEFT UP AFTER "IGNORE": ${leftUp}   CARDS SET ASIDE ON A QUESTION: ${wronglyGone}   wrong: ${wrong}/${ONLY ? ONLY.size : CASES.length}`);
    process.exit(wrong ? 1 : 0);
})();
