#!/usr/bin/env node
/**
 * Routine set-up eval (docs/ROUTINES_UX.md I9, step 4): given a request, does
 * the model make the right thing? Uses the app's OWN tool definitions
 * (create_routine, start_routine_interview, add_commitment) against a real
 * model, one turn, and reads the call it makes.
 *
 *   WRONG HOME     a routine for what is a commitment or the Now page, or the
 *                  wrong watcher / none where one exists
 *   WRONG TELLS    a watch made a delivery or the reverse
 *   TIME LOST      a time the person named is not on the trigger (I1)
 *   NO SENTENCE    no saysBack to confirm
 * Asking a clarifying question or opening the interview counts as a pass
 * only where the request leaves something open (marked `askOk`).
 *
 * LOOK_URL / LOOK_KEY / LOOK_MODEL as in tests/routine-look-eval.js.
 */
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const BASE = process.env.LOOK_URL || `http://127.0.0.1:${Number(process.env.LOOK_PORT) || 8097}/v1`;
const KEY = process.env.LOOK_KEY || '';
const MODEL = process.env.LOOK_MODEL || 'nenva-local';

const ctx = { window: {}, document: { addEventListener() {} }, console, setTimeout, FEATURES: { isEnabled: () => true }, localStorage: { getItem: () => null }, Commitments: require('../js/core/commitments.js') };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/agent/agent-tools.js'), 'utf8') + '\nthis.AgentTools = AgentTools;', ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/agent/commitment-tools.js'), 'utf8'), ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/apps/prompts/routine-interview.js'), 'utf8') + '\nthis.RoutineInterview = RoutineInterview;', ctx);
// What start_routine_interview returns: the real handler, over an empty routine list.
ctx.NotePrompts = { list: () => [], config: () => ({}), triggerLabel: () => '' };
ctx.UIUtils = { todayISO: () => '2026-10-09' };
const interviewResult = () => ctx.AgentTools.handlers.start_routine_interview();
const tools = ctx.AgentTools.definitions.filter(d => ['create_routine', 'start_routine_interview', 'add_commitment'].includes(d.function.name));
if (tools.length !== 3) { console.error('could not load the three tools:', tools.map(t => t.function.name)); process.exit(2); }

function chat(messages) {
    return new Promise((resolve) => {
        const url = new URL(`${BASE.replace(/\/$/, '')}/chat/completions`);
        const body = JSON.stringify({ model: MODEL, messages, tools, temperature: 0.2, max_tokens: 1200, stream: false, ...(KEY ? {} : { chat_template_kwargs: { enable_thinking: false } }) });
        const lib = url.protocol === 'https:' ? https : http;
        const req = lib.request({ hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80), path: url.pathname, method: 'POST',
            headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...(KEY ? { authorization: `Bearer ${KEY}`, 'X-Nenva-Work': 'background' } : {}) } }, (res) => {
            let data = ''; res.on('data', c => { data += c; });
            res.on('end', () => { try { resolve(JSON.parse(data).choices[0].message); } catch { resolve({ error: `bad answer (${res.statusCode})` }); } });
        });
        req.on('error', e => resolve({ error: e.message }));
        req.end(body);
    });
}
const SYSTEM = 'You are nenva, this person\'s own assistant on their Mac. Today is Friday, October 9, 2026. Their Gmail and Apple Calendar are connected, and so is their investment portfolio (accounts and a strategy called "Core Growth"). Use your tools to do what they ask; a tool that changes anything asks them to confirm.';

const cases = [
    { say: 'Keep track of the US visa bulletin and tell me when the EB-2 India dates change.', want: { tool: 'create_routine', watcher: null, tells: 'change' } },
    { say: 'Whenever the USPTO emails me about my trademark, tell me right away.', want: { tool: 'create_routine', watcher: 'mail' } },
    { say: 'Let me know when the AI sleeve of my Core Growth strategy goes over its band.', want: { tool: 'create_routine', watcher: 'money', tells: 'change' } },
    { say: 'Every weekday at 7am, give me a roundup of quantum computing news I have not seen.', want: { tool: 'create_routine', watcher: null, tells: 'each', time: '07:00' } },
    { say: 'Remind me to call the lawyer on Friday at 3pm.', want: { tool: 'add_commitment' } },
    { say: 'Set up a routine that gives me a morning briefing of my day every day.', want: { tool: null } }
];

const ONLY = (() => { const i = process.argv.indexOf('--only'); return i > 0 ? new Set(String(process.argv[i + 1]).split(',').map(Number)) : null; })();
(async () => {
    console.log(`Routine set-up eval — ${MODEL} at ${BASE}\n`);
    const n = { home: 0, tells: 0, time: 0, sentence: 0 };
    for (const [ci, c] of cases.entries()) {
        if (ONLY && !ONLY.has(ci + 1)) continue;
        // Up to five turns: the interview is played through, the person
        // answering "yes" to whatever is asked, until a tool other than the
        // interview is called or the model only replies.
        const convo = [{ role: 'system', content: SYSTEM }, { role: 'user', content: c.say }];
        let msg = null, call = null, turns = 0;
        for (; turns < 5; turns++) {
            msg = await chat(convo);
            if (msg.error) break;
            call = (msg.tool_calls || [])[0] || null;
            convo.push({ role: 'assistant', content: msg.content || '', ...(msg.tool_calls ? { tool_calls: msg.tool_calls } : {}) });
            if (call && call.function.name === 'start_routine_interview') { convo.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(interviewResult()) }); continue; }
            if (call) break;
            // Only a reply. Where a routine is wanted, the interview is going
            // on: the person says yes to whatever it asked. Where none is
            // wanted, the reply is the answer (a "yes" would be them insisting).
            if (c.want.tool !== 'create_routine') break;
            convo.push({ role: 'user', content: 'Yes, that\'s right. Go ahead.' });
        }
        if (msg.error) { console.log(`ERROR  ${c.say}  ${msg.error}`); continue; }
        const name = call ? call.function.name : null;
        let args = {}; try { args = call ? (typeof call.function.arguments === 'string' ? JSON.parse(call.function.arguments) : call.function.arguments) : {}; } catch { args = {}; }
        const fails = [];
        if (name !== c.want.tool) { n.home++; fails.push(`WRONG HOME: ${name || 'no tool'} (wanted ${c.want.tool || 'no routine'})`); }
        else if (name === 'create_routine') {
            if ((args.watcher || null) !== c.want.watcher) { n.home++; fails.push(`WRONG HOME: watcher ${args.watcher || 'none'} (wanted ${c.want.watcher || 'none'})`); }
            if (c.want.tells && args.tells !== c.want.tells) { n.tells++; fails.push(`WRONG TELLS: ${args.tells || 'none'}`); }
            if (c.want.time && !(args.trigger && args.trigger.time === c.want.time)) { n.time++; fails.push(`TIME LOST: ${JSON.stringify(args.trigger)}`); }
            if (!String(args.saysBack || '').trim()) { n.sentence++; fails.push('NO SENTENCE'); }
        }
        console.log(`${fails.length ? 'FAIL' : 'pass'}  ${c.say}${turns ? `  (${turns + 1} turns)` : ''}`);
        console.log(`      ${name || `(replied) ${String(msg.content || '').slice(0, 140).replace(/\s+/g, ' ')}`}${name === 'create_routine' ? ` watcher=${args.watcher || '-'} tells=${args.tells || '-'} trigger=${JSON.stringify(args.trigger || null)}\n      saysBack: ${args.saysBack || '-'}` : ''}`);
        for (const f of fails) console.log(`      ${f}`);
    }
    console.log(`\nWRONG HOME ${n.home} · WRONG TELLS ${n.tells} · TIME LOST ${n.time} · NO SENTENCE ${n.sentence}`);
    process.exit(n.home + n.tells + n.time + n.sentence ? 1 : 0);
})();
