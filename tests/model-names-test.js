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
eq('retired lite id', N.displayName({ engine: 'anjadhe', model: 'anjadhe-cloud' }), 'nenva cloud lite');
eq('retired pro id', N.displayName({ engine: 'anjadhe', model: 'anjadhe-cloud-qwen3.8' }), 'nenva cloud pro');
eq('a known tier ignores a vendor label', N.displayName({ engine: 'anjadhe', model: 'anjadhe-cloud', label: 'DeepSeek-V4-Flash-0731' }), 'nenva cloud lite');
eq('an unknown cloud id never shows its label', N.displayName({ engine: 'anjadhe', model: 'anjadhe-cloud-max', label: 'Qwen3.8-2.4T-A95B' }), 'nenva cloud');
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
eq('old cloud id', N.displayForStoredModel('anjadhe-cloud'), 'nenva cloud lite');
eq('old pro id', N.displayForStoredModel('anjadhe-cloud-qwen3.8'), 'nenva cloud pro');
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

console.log('N3: ids an older Connect still knows');
eq('publicId lite', N.publicId('anjadhe-cloud'), 'nenva-cloud-lite');
eq('publicId pro', N.publicId('anjadhe-cloud-qwen3.8'), 'nenva-cloud-pro');
eq('publicId passes a tier id', N.publicId('nenva-cloud-pro'), 'nenva-cloud-pro');
eq('legacyId lite', N.legacyId('nenva-cloud-lite'), 'anjadhe-cloud');
eq('legacyId pro', N.legacyId('nenva-cloud-pro'), 'anjadhe-cloud-qwen3.8');
eq('legacyId unknown', N.legacyId('nenva-cloud-max'), null);
eq('default cloud model', N.DEFAULT_CLOUD_MODEL, 'nenva-cloud-lite');
{
    const row = N.catalogRow({ id: 'anjadhe-cloud-qwen3.8', label: 'Qwen3.8-2.4T-A95B', description: 'Qwen 3.8, 2.4T params' });
    eq('catalog row id', row.id, 'nenva-cloud-pro');
    eq('catalog row label', row.label, 'nenva cloud pro');
    check('catalog row description names no model', !/qwen/i.test(row.description), row.description);
    const fb = N.catalogRow({ id: 'nenva-cloud-lite' });
    eq('fallback row', fb.label, 'nenva cloud lite');
    check('a row without vision does not claim it', fb.vision === undefined);
    eq('the vision flag rides through', N.catalogRow({ id: 'nenva-cloud-lite', vision: true }).vision, true);
    check('only an explicit true counts', N.catalogRow({ id: 'nenva-cloud-lite', vision: 'yes' }).vision === undefined);
}

console.log('N4: the migration');
{
    const settings = {
        modelList: [
            { id: 'e1', engine: 'anjadhe', model: 'anjadhe-cloud', label: 'DeepSeek-V4-Flash-0731' },
            { id: 'e2', engine: 'anjadhe', model: 'anjadhe-cloud-qwen3.8', label: 'Qwen3.8-2.4T-A95B' },
            { id: 'e3', engine: 'llamacpp', model: 'gemma4:12b-it-qat' },
            { id: 'e4', engine: 'server', model: 'mix', baseUrl: 'http://box' }
        ],
        defaultModelId: 'e2',
        selectedModel: 'anjadhe-cloud-qwen3.8',
        cloudBrainModel: 'anjadhe-cloud',
        modelRoutes: { email: 'e1' }
    };
    const res = N.migrateSettings(settings);
    check('changed', res.changed === true);
    eq('e1 model', settings.modelList[0].model, 'nenva-cloud-lite');
    eq('e1 label', settings.modelList[0].label, 'nenva cloud lite');
    eq('e2 model', settings.modelList[1].model, 'nenva-cloud-pro');
    eq('e2 label', settings.modelList[1].label, 'nenva cloud pro');
    check('entry ids unchanged', settings.modelList.map(e => e.id).join() === 'e1,e2,e3,e4');
    check('local and server entries untouched', settings.modelList[2].model === 'gemma4:12b-it-qat' && !settings.modelList[2].label
        && settings.modelList[3].model === 'mix');
    eq('selectedModel', settings.selectedModel, 'nenva-cloud-pro');
    eq('cloudBrainModel', settings.cloudBrainModel, 'nenva-cloud-lite');
    eq('routes untouched', settings.modelRoutes.email, 'e1');
    eq('defaultModelId untouched', settings.defaultModelId, 'e2');
    eq('retired label recorded', res.retired['qwen3.8-2.4t-a95b'], 'nenva cloud pro');
    const again = N.migrateSettings(settings);
    check('idempotent', again.changed === false && Object.keys(again.retired).length === 0);
    check('empty settings', N.migrateSettings({}).changed === false);
}
{
    const p = N.migratePhoneAI({ fallback: { engine: 'anjadhe', model: 'anjadhe-cloud-qwen3.8', label: 'Qwen3.8-2.4T-A95B' }, updatedAt: 'x' });
    check('phone-ai changed', p.changed);
    eq('phone-ai model', p.value.fallback.model, 'nenva-cloud-pro');
    eq('phone-ai label', p.value.fallback.label, 'nenva cloud pro');
    check('phone-ai idempotent', N.migratePhoneAI(p.value).changed === false);
    check('phone-ai off stays off', N.migratePhoneAI({ fallback: null }).changed === false);
    check('phone-ai absent', N.migratePhoneAI(null).changed === false);
}

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nmodel-names: all passed');
