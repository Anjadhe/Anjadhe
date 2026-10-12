#!/usr/bin/env node
/**
 * Sender facts eval (docs/SENDERS.md M5, MemoryCapture K7): in a sender's
 * thread, does the after-turn look keep a lasting fact about the THING on
 * the sender, a fact about the PERSON in Memory, and nothing for an action
 * on one item or a question? Runs MemoryCapture's own _capture against a
 * model; only the transport and the stores are stubbed. Fixtures SYNTHETIC.
 *
 * The numbers (all should be zero):
 *   MISSED        a thing fact that was not kept on the sender
 *   WRONG HOME    a thing fact kept in Memory, or a person fact on the sender
 *   INVENTED      something kept from a turn that holds nothing to keep
 *   NOT REPLACED  a changed fact kept beside the old one instead of over it
 *
 *   SENDERS_PORT=8097 node tests/sender-facts-eval.js [--verbose]
 *   SENDERS_URL=https://api.nenva.co/v1/llm SENDERS_KEY=<a Connect key> SENDERS_MODEL=nenva-cloud-lite node tests/sender-facts-eval.js
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
global.AgentService = { model: MODEL, numCtx: 16384, _persistConversation() {}, _syncActiveConversation() {}, _streamingState: new Map(), _parseFirstJsonArray: () => null };
global.LLMLogger = {
    call: (tag, p) => new Promise((resolve) => {
        const url = new URL(`${BASE.replace(/\/$/, '')}/chat/completions`);
        const body = JSON.stringify({ model: p.model, messages: p.messages, temperature: 0.1, max_tokens: 600, stream: false,
            ...(KEY ? {} : { chat_template_kwargs: { enable_thinking: false } }) });
        const lib = url.protocol === 'https:' ? https : http;
        const req = lib.request({ hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80), path: url.pathname, method: 'POST',
            headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...(KEY ? { authorization: `Bearer ${KEY}`, 'X-Nenva-Work': 'background' } : {}) } }, (res) => {
            let data = '';
            res.on('data', c => { data += c; });
            res.on('end', () => {
                try { const content = JSON.parse(data).choices[0].message.content; if (VERBOSE) console.log(`    [${tag}] ${String(content).replace(/\s+/g, ' ').slice(0, 500)}`); resolve({ message: { content } }); }
                catch { resolve({ error: `bad answer: ${String(data).slice(0, 160)}` }); }
            });
        });
        req.on('error', e => resolve({ error: e.message }));
        req.end(body);
    })
};
let memory = [];
global.MemoryManager = {
    HEADINGS: [{ id: 'about', label: 'About you' }, { id: 'people', label: 'People' }, { id: 'preferences', label: 'Preferences' }, { id: 'plans', label: 'Plans' }, { id: 'email', label: 'Email' }],
    all: () => memory, search: () => [], _forgotten: new Map(),
    remember: (f) => { memory.push({ id: `m${memory.length}`, ...f }); return { status: 'saved', fact: memory.at(-1) }; },
    forget: (id) => { const f = memory.find(x => x.id === id); memory = memory.filter(x => x.id !== id); return f; }
};
global.SenderKinds = require('../js/core/sender-kinds.js');
global.Senders = require('../js/core/senders.js');
Senders._changed = () => {};
const MemoryCapture = require('../js/agent/memory-capture.js');

// thing: a fact that belongs on the sender; person: one that belongs in Memory; replaces: the known fact's subject it should replace.
const CASES = [
    { id: 'f1', said: 'Our policy number is GX-4471-22 and the agent is Dana Ruiz, 555-201-7788.', thing: 2 },
    { id: 'f2', said: 'I paid the renewal yesterday, all done.', none: true },
    { id: 'f3', said: 'My daughter Maya turns 9 on March 3.', person: 1 },
    { id: 'f4', said: 'We decided to switch to State Farm when this renews.', thing: 1 },
    { id: 'f5', said: 'Dana left the agency, our agent is Priya Shah now.', thing: 1, known: [{ subject: 'agent', text: 'Agent is Dana Ruiz, 555-201-7788.' }], replaces: 'agent' },
    { id: 'f6', said: 'What does my policy actually cover?', none: true },
    { id: 'f7', said: 'It covers both our cars and roadside assistance is included.', thing: 1 },
    { id: 'f8', said: 'In general I prefer a text to a phone call from anyone.', person: 1 }
];

(async () => {
    const out = { missed: [], home: [], invented: [], notReplaced: [] };
    for (const c of CASES) {
        blob = null; Senders._data = null; memory = [];
        const s = Senders.create('Auto insurance', 'Covered, paid, the renewal not missed, the price still fair.');
        for (const k of c.known || []) Senders.keepFact(s.id, k);
        const before = Senders.factsOf(s.id).length;
        const conv = { id: `c-${c.id}`, todayKey: process.argv.includes('--baseline') ? null : s.id, messages: [{ role: 'user', content: c.said }, { role: 'assistant', content: 'Got it.' }] };
        await MemoryCapture._capture(conv, conv.messages[1], { answerText: 'Got it.' });
        const facts = Senders.factsOf(s.id);
        const added = facts.length - before;
        const onThing = facts.filter(f => !(c.known || []).some(k => k.text === f.text));
        console.log(`  ${c.id} "${c.said}"\n      on sender: ${onThing.map(f => f.text).join(' | ') || '-'}\n      in memory: ${memory.map(f => `${f.text} [${f.heading}]`).join(' | ') || '-'}`);
        if (c.none && (onThing.length || memory.length)) out.invented.push(c.id);
        if (c.thing && onThing.length < 1) out.missed.push(c.id);
        if (c.thing && memory.length) out.home.push(`${c.id} (in memory)`);
        if (c.person && onThing.length) out.home.push(`${c.id} (on the sender)`);
        if (c.person && !memory.length) out.missed.push(c.id);
        if (c.replaces && added > 0) out.notReplaced.push(c.id);
    }
    console.log(`\nMISSED ${out.missed.length} ${out.missed.join(' ')} · WRONG HOME ${out.home.length} ${out.home.join(' ')} · INVENTED ${out.invented.length} ${out.invented.join(' ')} · NOT REPLACED ${out.notReplaced.length} ${out.notReplaced.join(' ')}`);
    process.exit(out.missed.length + out.home.length + out.invented.length + out.notReplaced.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
