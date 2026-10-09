// The 2026-10-01 launcher simplification (AppManager.simplifyLauncherOnce):
// one small launcher for every install, new and existing, except that an app
// this Mac opened in the last 30 days stays where its user left it.
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

const NOW = Date.parse('2026-10-01T12:00:00Z');
const DAY = 86400000;

// A new install: everything outside the core set goes to More apps.
{
    const { am, store } = load();
    am.simplifyLauncherOnce(NOW);
    const hidden = new Set(store['hidden-apps'].apps);
    for (const id of am.SIMPLE_LAUNCHER_HIDDEN) assert.ok(hidden.has(id), `${id} hidden on a new install`);
    for (const id of ['actions', 'notes', 'calendar', 'prompts']) assert.ok(hidden.has(id), `${id} hidden on a new install (steps b, c, d)`);
    for (const id of ['agent', 'fyi', 'email', 'settings']) {
        assert.ok(!hidden.has(id), `${id} stays in the launcher`);
    }
    assert.equal(store['hidden-apps'].simpleLauncher2026_10, true);
    assert.equal(store['hidden-apps'].simpleLauncher2026_10b, true);
    assert.equal(store['hidden-apps'].simpleLauncher2026_10c, true);
    assert.equal(store['hidden-apps'].simpleLauncher2026_10d, true, 'Routines hidden too (2026-10-06)');
}

// A Mac that ran step one, then re-enabled Journal: step b hides Notes and
// Tasks (unless recently used) and leaves Journal alone.
{
    const { am, store } = load({
        stored: { apps: ['news', 'prompts'], simpleLauncher2026_10: true },
        usage: { actions: { count: 50, last: NOW - DAY } }
    });
    am.simplifyLauncherOnce(NOW);
    const hidden = new Set(store['hidden-apps'].apps);
    assert.ok(hidden.has('notes'), 'step b reaches a Mac that ran step one');
    assert.ok(!hidden.has('actions'), 'Tasks used yesterday stays');
    assert.ok(!hidden.has('journal'), 'step one is not re-run over a re-enable');
    assert.equal(store['hidden-apps'].simpleLauncher2026_10b, true);
}

// An existing install: recent use keeps an app; stale use does not; earlier
// hides and earlier migration stamps survive.
{
    const { am, store } = load({
        stored: { apps: ['wellness'], defaultHidden2026_08: true, agentUnhidden2026_08: true },
        usage: {
            journal: { count: 40, last: NOW - 2 * DAY },     // writes every night
            portfolio: { count: 12, last: NOW - 29 * DAY },  // inside the window
            news: { count: 90, last: NOW - 45 * DAY },       // used to, not lately
            goals: { count: 3, last: 2 }                     // legacy-recents seed: position, not time
        }
    });
    am.simplifyLauncherOnce(NOW);
    const d = store['hidden-apps'];
    const hidden = new Set(d.apps);
    assert.ok(!hidden.has('journal'), 'an app opened this week stays');
    assert.ok(!hidden.has('portfolio'), 'an app opened within 30 days stays');
    assert.ok(hidden.has('news'), 'heavy use long ago does not keep an app');
    assert.ok(hidden.has('goals'), 'a legacy position seed is not recency');
    assert.ok(hidden.has('wellness'), 'an earlier hide survives');
    assert.equal(d.defaultHidden2026_08, true, 'earlier stamps survive');
    assert.equal(d.agentUnhidden2026_08, true);
}

// Once only: a user who re-enables an app on More apps keeps it.
{
    const { am, store } = load();
    am.simplifyLauncherOnce(NOW);
    const set = am.getHiddenApps();
    set.delete('journal');
    am.setHiddenApps(set);
    am.simplifyLauncherOnce(NOW + DAY);
    assert.ok(!am.getHiddenApps().has('journal'), 're-enabled stays enabled');
    assert.equal(store['hidden-apps'].simpleLauncher2026_10, true, 'setHiddenApps keeps the stamp');
}

console.log('simple-launcher: new install, recent-use exception, once-only passed (incl. step b)');
