#!/usr/bin/env node
/**
 * ModelRouting's pure core (js/agent/model-routing.js) — which model
 * answers which part of the app.
 *
 * The laws under test are R1 (an unassigned surface is untouched), R3 (one
 * local model in play, ever) and R5 (a dangling assignment is not a
 * dependency). The first is the one that keeps this change invisible until
 * the user asks for it; the third is the one that keeps a deleted model
 * from silently redirecting the user's email to the cloud.
 *
 *   node tests/model-routing-test.js
 */

const M = require('../js/agent/model-routing.js');

let failures = 0;
function check(name, cond, detail) {
    if (cond) { console.log(`  ok  ${name}`); return; }
    failures++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
}

const LOCAL_A = { id: 'la', engine: 'llamacpp', model: 'gemma-12b' };
const LOCAL_B = { id: 'lb', engine: 'llamacpp', model: 'qwen-4b' };
const CLOUD = { id: 'c1', engine: 'anjadhe', model: 'anjadhe-cloud', label: 'Anjadhe Cloud' };
const OPENAI = { id: 'o1', engine: 'openai', model: 'gpt-x' };
const SERVER = { id: 's1', engine: 'server', model: 'mix', baseUrl: 'http://box:8080' };
const LIST = [LOCAL_A, LOCAL_B, CLOUD, OPENAI, SERVER];

// ── the source → surface table ─────────────────────────────────────────
console.log('which surface owns a source tag');
const cases = {
    'agent': 'assistant', 'noticing': 'assistant',
    'email': 'email', 'email-threads': 'email', 'email-bundles': 'email',
    'imessage': 'email', 'imessage-reservation': 'email',
    'news-summary': 'news', 'discover-digest': 'news',
    'doc-tidy': 'documents', 'doc-vision': 'documents',
    'portfolio-profile': 'portfolio', 'portfolio-brief': 'portfolio',
    'prompt-feed': 'routines', 'task': 'routines', 'task-step': 'routines',
    'memory-extract': 'quick', 'ctx-summary': 'quick', 'actions-filing': 'quick',
    'browse-reader-improve': 'quick', 'prompt-suggestions': 'quick'
};
for (const [tag, want] of Object.entries(cases)) {
    check(`${tag} → ${want}`, M.surfaceOf(tag) === want, M.surfaceOf(tag));
}
check('an unknown tag falls to the assistant, which is the brain',
    M.surfaceOf('some-new-package-pass') === 'assistant');
check('every surface id is unique',
    new Set(M.SURFACES.map(s => s.id)).size === M.SURFACES.length);
check('exactly one fixed surface', M.SURFACES.filter(s => s.fixed).length === 1);
check('no source tag is claimed by two surfaces', (() => {
    const seen = new Set();
    for (const s of M.SURFACES) for (const t of s.sources) { if (seen.has(t)) return false; seen.add(t); }
    return true;
})());

// ── R1: nothing changes until the user asks ────────────────────────────
console.log('R1 — an unassigned surface is left alone');
check('no assignments → the brain answers, no override',
    (() => { const r = M.resolve({}, LIST, LOCAL_A, 'email'); return r.entry === LOCAL_A && !r.overrides && !r.assigned; })());
check('an assignment naming the brain is not an override',
    (() => { const r = M.resolve({ email: 'la' }, LIST, LOCAL_A, 'email'); return r.entry === LOCAL_A && !r.overrides; })());
check('no brain and no assignment → nothing to route',
    (() => { const r = M.resolve({}, LIST, null, 'email'); return r.entry === null && !r.overrides; })());
check('a different entry IS an override',
    (() => { const r = M.resolve({ email: 'c1' }, LIST, LOCAL_A, 'email'); return r.entry === CLOUD && r.overrides && r.assigned; })());

// ── the fixed surface ──────────────────────────────────────────────────
console.log('the assistant surface is the brain');
check('assistant ignores an assignment',
    (() => { const r = M.resolve({ assistant: 'c1' }, LIST, LOCAL_A, 'assistant'); return r.entry === LOCAL_A && !r.overrides; })());
check('prune drops an assignment to a fixed surface',
    !('assistant' in M.prune({ assistant: 'c1', email: 'c1' }, LIST)));
check('assignable() excludes it', !M.assignable().some(s => s.fixed));

// ── R3: one local model in play ────────────────────────────────────────
console.log('R3 — this Mac holds one local model at a time');
check('a local brain is the one in play',
    M.localInPlay({ email: 'lb' }, LIST, LOCAL_A) === LOCAL_A);
check('with a cloud brain, the first local assignment is the one in play',
    M.localInPlay({ news: 'lb' }, LIST, CLOUD) === LOCAL_B);
check('a second local assignment is coerced onto the one in play, never off-Mac',
    (() => { const r = M.resolve({ email: 'lb' }, LIST, LOCAL_A, 'email'); return r.entry === LOCAL_A && r.coerced; })());
check('the coerced surface is reported as a conflict',
    M.conflicts({ email: 'lb' }, LIST, LOCAL_A).join() === 'email');
check('two local assignments under a cloud brain: the second is the conflict',
    M.conflicts({ email: 'la', news: 'lb' }, LIST, CLOUD).join() === 'news');
check('remote assignments never conflict with each other',
    M.conflicts({ email: 'c1', news: 'o1', documents: 's1' }, LIST, LOCAL_A).length === 0);
check('one local assignment under a cloud brain is fine',
    M.conflicts({ email: 'lb' }, LIST, CLOUD).length === 0
    && M.resolve({ email: 'lb' }, LIST, CLOUD, 'email').entry === LOCAL_B);

// ── R5: a dangling assignment is not a dependency ──────────────────────
console.log('R5 — a deleted model falls back to the brain');
check('a dangling id resolves to the brain, unassigned',
    (() => { const r = M.resolve({ email: 'gone' }, LIST, LOCAL_A, 'email'); return r.entry === LOCAL_A && !r.assigned && !r.overrides; })());
check('prune drops it', !('email' in M.prune({ email: 'gone' }, LIST)));
check('prune keeps a live one', M.prune({ email: 'c1' }, LIST).email === 'c1');
check('prune drops an unknown surface', !('made-up' in M.prune({ 'made-up': 'c1' }, LIST)));

// ── the params patch ───────────────────────────────────────────────────
console.log('the routing patch main reads');
check('local: engine + model, no entry id (the key is per-spawn)',
    JSON.stringify(M.routingFor(LOCAL_A)) === JSON.stringify({ model: 'gemma-12b', engine: 'llamacpp' }));
check('local with a context override carries numCtx out of band',
    M.routingFor({ ...LOCAL_A, numCtx: 16384 }).numCtx === 16384);
check('a cloud entry carries its id so main can resolve the key',
    (() => { const r = M.routingFor(CLOUD); return r.engine === 'anjadhe' && r.entryId === 'c1' && r.numCtx === undefined; })());
check('a server entry carries its endpoint too',
    (() => { const r = M.routingFor(SERVER); return r.engine === 'server' && r.entryId === 's1' && r.baseUrl === 'http://box:8080'; })());
check('an entry with no model routes nowhere', M.routingFor({ id: 'x', engine: 'openai' }) === null);
check('no entry routes nowhere', M.routingFor(null) === null);
check('an engine-less entry is local (legacy rows)',
    M.isLocal({ id: 'z', model: 'm' }) && M.routingFor({ id: 'z', model: 'm' }).engine === 'llamacpp');

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nmodel-routing: all good');
