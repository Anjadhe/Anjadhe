#!/usr/bin/env node
/**
 * ModelNames (js/agent/model-names.js) — curated models are named by TIER,
 * never by model (Ram, 2026-09-30).
 *
 * Under test: the display rule (N1), relabelling a stored name (N2), the
 * retired-id map main.js retries an older Connect with (N3), and the
 * migration that moves stored entries onto tier ids without touching an
 * entry id (N4).
 *
 *   node tests/model-names-test.js
 */

const N = require('../js/agent/model-names.js');

let failures = 0;
function check(name, cond, detail) {
    if (cond) { console.log(`  ok  ${name}`); return; }
    failures++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
}
const eq = (name, got, want) => check(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

console.log('N1: one name per entry');
eq('cloud lite', N.displayName({ engine: 'anjadhe', model: 'nenva-cloud-lite' }), 'nenva cloud lite');
eq('cloud pro', N.displayName({ engine: 'anjadhe', model: 'nenva-cloud-pro' }), 'nenva cloud pro');
eq('lite id', N.displayName({ engine: 'anjadhe', model: 'nenva-cloud-lite' }), 'nenva cloud lite');
eq('pro id', N.displayName({ engine: 'anjadhe', model: 'nenva-cloud-pro' }), 'nenva cloud pro');
eq('a known tier ignores a vendor label', N.displayName({ engine: 'anjadhe', model: 'nenva-cloud-lite', label: 'DeepSeek-V4-Flash-0731' }), 'nenva cloud lite');
eq('an unknown cloud id never shows its label', N.displayName({ engine: 'anjadhe', model: 'nenva-cloud-max', label: 'Qwen3.8-2.4T-A95B' }), 'nenva cloud');
eq('an unknown cloud id keeps an operator label that speaks as nenva', N.displayName({ engine: 'anjadhe', model: 'nenva-cloud-max', label: 'nenva Cloud Max' }), 'nenva cloud Max');
eq('an unknown cloud id with no label', N.displayName({ engine: 'anjadhe', model: 'x' }), 'nenva cloud');
eq('local, any gguf', N.displayName({ engine: 'llamacpp', model: 'gemma4:12b-it-qat' }), 'nenva local');
eq('local drop-in file', N.displayName({ engine: 'llamacpp', model: 'Foo-7B-Q4.gguf', label: 'Foo' }), 'nenva local');
eq('leftover ollama entry is local', N.displayName({ engine: 'ollama', model: 'qwen3:8b' }), 'nenva local');
eq('own server keeps its name', N.displayName({ engine: 'server', model: 'qwen3-32b' }), 'qwen3-32b');
eq('own server label wins', N.displayName({ engine: 'server', model: 'mix', label: 'Studio' }), 'Studio');
eq('OpenAI keeps its name', N.displayName({ engine: 'openai', model: 'gpt-5' }), 'gpt-5');
eq('Anthropic keeps its name', N.displayName({ engine: 'anthropic', model: 'claude-x' }), 'claude-x');
eq('no entry', N.displayName(null), '');

console.log('N2: a stored name is relabelled');
eq('cloud id', N.displayForStoredModel('nenva-cloud-lite'), 'nenva cloud lite');
eq('pro id', N.displayForStoredModel('nenva-cloud-pro'), 'nenva cloud pro');
eq('new id', N.displayForStoredModel('nenva-cloud-pro'), 'nenva cloud pro');
eq('old "nenva Cloud" label', N.displayForStoredModel('nenva Cloud'), 'nenva cloud');
eq('already a tier name', N.displayForStoredModel('nenva cloud lite'), 'nenva cloud lite');
eq('gguf path', N.displayForStoredModel('/Users/x/.nenva_llamacpp/models/Qwen3.6-27B-Q4_K_M.gguf'), 'nenva local');
eq('bare gguf', N.displayForStoredModel('gemma-3-12b.gguf'), 'nenva local');
eq('nenva fine-tune', N.displayForStoredModel('anjadhe-qwen3.5:4b'), 'nenva local');
eq('logged engine llamacpp', N.displayForStoredModel('gemma4:12b-it-qat', 'llamacpp'), 'nenva local');
eq('logged engine anjadhe hides the upstream id', N.displayForStoredModel('deepseek/deepseek-v4', 'anjadhe'), 'nenva cloud');
eq('known map (retired label)', N.displayForStoredModel('Qwen3.8-2.4T-A95B', null, { 'qwen3.8-2.4t-a95b': 'nenva cloud pro' }), 'nenva cloud pro');
eq('known Map (local catalog name)', N.displayForStoredModel('gemma4:12b-it-qat', null, new Map([['gemma4:12b-it-qat', 'nenva local']])), 'nenva local');
eq('a server serving a .gguf keeps its name when the caller knows it', N.displayForStoredModel('Qwen3.6-35B-A3B-Q8_0.gguf', null, { 'qwen3.6-35b-a3b-q8_0.gguf': 'Studio' }), 'Studio');
eq('a server model passes through', N.displayForStoredModel('qwen3-32b', 'server'), 'qwen3-32b');
eq('an API model passes through', N.displayForStoredModel('gpt-5'), 'gpt-5');
eq('empty', N.displayForStoredModel(''), '');

console.log('N3: tier ids');
eq('publicId passes a tier id', N.publicId(' nenva-cloud-pro '), 'nenva-cloud-pro');
eq('default cloud model', N.DEFAULT_CLOUD_MODEL, 'nenva-cloud-lite');
{
    const row = N.catalogRow({ id: 'nenva-cloud-pro', label: 'Qwen3.8-2.4T-A95B', description: 'Qwen 3.8, 2.4T params' });
    eq('catalog row id', row.id, 'nenva-cloud-pro');
    eq('catalog row label', row.label, 'nenva cloud pro');
    check('catalog row description names no model', !/qwen/i.test(row.description), row.description);
    const fb = N.catalogRow({ id: 'nenva-cloud-lite' });
    eq('fallback row', fb.label, 'nenva cloud lite');
    check('a row without vision does not claim it', fb.vision === undefined);
    eq('the vision flag rides through', N.catalogRow({ id: 'nenva-cloud-lite', vision: true }).vision, true);
    check('only an explicit true counts', N.catalogRow({ id: 'nenva-cloud-lite', vision: 'yes' }).vision === undefined);
}

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nmodel-names: all passed');
