#!/usr/bin/env node
/**
 * Instructions eval — does the mail filer follow a standing instruction
 * (docs/ROUTINES_UX.md I2, step 3)? Runs Matters' OWN judge (prompt, model
 * call, checks) on synthetic mail against a real model, with one instruction:
 * "When the USPTO writes about my trademark, tell me right away."
 *
 *   MISSED         a message the instruction is about, not tied to it or not told now
 *   WRONGLY TIED   a message it is not about, tied to it
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
        const body = JSON.stringify({ model: MODEL, messages: p.messages, temperature: 0.1, max_tokens: 1000, stream: false, response_format: { type: 'json_object' },
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
const I = require('../js/core/instructions.js');
global.Instructions = I;
I.forWatcher = (w) => (w === 'mail' ? [{ id: 'r-uspto', title: 'USPTO watch', body: 'When the USPTO writes about my trademark, tell me right away.', when: null }] : []);
let blob = null;
global.StorageManager = { get: () => blob, set: (_k, v) => { blob = v; } };
const M = require('../js/core/matters.js');
M._inference = ({ params }) => chat(params);

const mail = (id, from, subject, body, about) => ({ m: { messageId: id, from, subject, bodyText: body, date: '2026-10-09T10:00:00Z' }, about });
const cases = [
    mail('e1', 'TEAS <TEAS@uspto.gov>', 'Office action issued: serial 98765432', 'The USPTO issued an office action on your trademark application, serial 98765432 (NENVA). A response is due within three months.', true),
    mail('e2', 'USPTO <noreply@uspto.gov>', 'Notice of publication: serial 98765432', 'Your mark NENVA, serial 98765432, will be published for opposition in the Official Gazette on Nov 4, 2026.', true),
    mail('e3', 'USPTO News <news@uspto.gov>', 'USPTO newsletter: new fee schedule webinar', 'Join our webinar on the new patent fee schedule. Register today.', false),
    mail('e4', 'City Water <billing@citywater.gov>', 'Your bill is due Oct 20', 'Your water bill of $64.20 is due Oct 20.', false)
];
(async () => {
    console.log(`Instructions eval — ${MODEL} at ${BASE}\n`);
    let missed = 0, wrong = 0;
    for (const c of cases) {
        const f = M.facts(c.m, { summary: c.m.subject }, c.m.bodyText);
        const out = await M.judge(f);
        const j = out && out.j;
        const tied = !!(j && j.instruction === 'r-uspto');
        let verdict = 'pass';
        if (!j) verdict = `ERROR ${out && out.error}`;
        else if (c.about && (!tied || j.tell !== 'now')) { missed++; verdict = 'MISSED'; }
        else if (!c.about && tied) { wrong++; verdict = 'WRONGLY TIED'; }
        console.log(`${verdict.padEnd(12)} ${c.m.subject}  →  ${j ? `${j.about === 'none' ? 'none' : `"${j.title}"`} tell=${j.tell} instruction=${j.instruction || '-'}` : ''}`);
    }
    console.log(`\nMISSED ${missed} · WRONGLY TIED ${wrong}`);
    process.exit(missed + wrong ? 1 : 0);
})();
