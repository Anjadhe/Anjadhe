// The small launcher (AppManager.getHiddenApps, 2026-10-01): an install that
// never chose starts with the default hidden set; a choice is kept as made.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../js/core/app-manager.js'), 'utf8');

function load({ stored = null, usage = null } = {}) {
    const store = { 'hidden-apps': stored };
    const local = { 'app-usage': usage ? JSON.stringify(usage) : null };
    const ctx = {
        console,
        window: {},
        document: { addEventListener() {} },
        localStorage: {
            getItem: k => local[k] ?? null,
            setItem: (k, v) => { local[k] = v; },
            removeItem: k => { delete local[k]; }
        },
        StorageManager: {
            get: k => (store[k] === undefined ? null : JSON.parse(JSON.stringify(store[k]))),
            set: (k, v) => { store[k] = v; }
        }
    };
    vm.createContext(ctx);
    vm.runInContext(source + '\nthis.AppManager = AppManager;', ctx);
    return { am: ctx.AppManager, store };
}

// A new install: the default set, including what a bundled package asks for.
{
    const { am } = load();
    am.DEFAULT_HIDDEN_APPS.push('portfolio');
    const hidden = am.getHiddenApps();
    for (const id of am.LAUNCHER_HIDDEN) assert.ok(hidden.has(id), `${id} hidden on a new install`);
    for (const id of ['agent', 'fyi', 'settings']) assert.ok(!hidden.has(id), `${id} stays in the launcher`);
}

// A choice is kept exactly, even an empty one.
{
    const { am, store } = load({ stored: { apps: ['notes'] } });
    assert.equal(JSON.stringify([...am.getHiddenApps()]), '["notes"]');
    am.setHiddenApps(new Set());
    assert.equal(JSON.stringify(store['hidden-apps']), '{"apps":[]}');
    assert.equal(am.getHiddenApps().size, 0, 'showing everything is a choice too');
}

console.log('simple-launcher: default set for a new install, a choice kept as made');
