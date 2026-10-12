// Retired settings cannot leave a loader/bridge/background worker behind.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const html = read('index.html');
for (const match of html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)) {
    assert.ok(fs.existsSync(path.join(root, match[1])), `loaded script exists: ${match[1]}`);
}
assert.doesNotMatch(html, /settings-userapps|settings-insight-report|settings-reset-insights/);
assert.doesNotMatch(read('preload.js'), /exposeInMainWorld\('electronApps'/);
assert.doesNotMatch(read('main.js'), /ipcMain\.handle\('(?:user-apps-|userapp-)|startUserAppsWatcher|refreshUserAppsDocs|anjadhe-userapp/);
assert.doesNotMatch(read('js/core/app-manager.js'), /_loadUserApps|UserAppsSync|PromptSuggestions/);
assert.doesNotMatch(read('js/apps/email/email-app.js'), /resetInsights|noiseReport|_countNotified/);
assert.doesNotMatch(read('js/agent/agent-tools.js'), /list_creations|read_creation/);
assert.doesNotMatch(read('js/apps/settings/settings-app.js'), /Suggested prompts written for you|_loadUserAppsSettings|resetInsights|InsightReport/);

// Old opt-ins cannot resurrect a retired feature.
const ctx = vm.createContext({
    window: { electronConfig: { featureFlags: () => ({}) } },
    localStorage: { getItem: () => 'aisuggestions,sandboxUserApps' },
    StorageManager: { get: () => null }
});
vm.runInContext(read('js/core/feature-policy.js') + '\n' + read('js/core/features.js'), ctx);
assert.equal(vm.runInContext("FEATURES.isEnabled('aisuggestions')", ctx), false);
assert.equal(vm.runInContext("FEATURES.isEnabled('sandboxUserApps')", ctx), false);

// The built-in packages still have their manifest and cross-app API contract.
const AppManifest = require('../js/core/app-manifest');
for (const id of JSON.parse(read('js/apps/bundled.json'))) {
    const result = AppManifest.validate(JSON.parse(read(`js/apps/${id}/manifest.json`)), { bundled: true });
    assert.equal(result.ok, true, `${id}: ${JSON.stringify(result.errors)}`);
}
vm.runInContext(read('js/core/anjadhe-sdk.js'), ctx);
assert.equal(vm.runInContext("Anjadhe.expose('probe', { title: 'kept' }); Anjadhe.use('probe').title", ctx), 'kept');
assert.equal(vm.runInContext("Anjadhe.unexpose('probe'); Anjadhe.use('probe')", ctx), null);
assert.equal(vm.runInContext('typeof Anjadhe.registerApp', ctx), 'undefined');
vm.runInContext(read('js/agent/agent-ui.js'), ctx);
const prompts = vm.runInContext('AgentUI.generalSuggestions()', ctx);
assert.ok(prompts.length > 0, 'static chat starters remain available without a writer or model');
console.log('retired-settings-features: no runtime doors, stale opt-ins inert, bundled apps and static starters preserved');
