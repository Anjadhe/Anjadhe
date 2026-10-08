// First-run registration requires an email and must save before finishing.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');
const read = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const success = { licensed: true, class: 'free', created: true };

function setup({ claim = async () => success, complete = async () => {} } = {}) {
    const dom = new JSDOM(read('index.html'), {
        url: 'https://test.invalid', runScripts: 'outside-only', virtualConsole: new VirtualConsole()
    });
    const w = dom.window;
    const calls = { emails: [], completed: 0, events: [], models: [] };
    w.UIUtils = { escapeHtml: value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;') };
    w.ModelNames = { DEFAULT_CLOUD_MODEL: 'nenva-cloud-lite', cloudLabel: id => id.replaceAll('-', ' ') };
    w.electronLLM = { anjadheModels: async () => ({ models: [{ id: 'nenva-cloud-lite' }, { id: 'nenva-cloud-pro' }] }) };
    w.electronConfig = { get: async () => ({ machine: { totalMemGB: 16 }, models: [] }) };
    w.electronLicense = { claim: async email => { calls.emails.push(email); return claim(); } };
    w.electronStore = { markSetupComplete: async () => { await complete(); calls.completed++; } };
    w.electronSearch = { askFirst: async () => {} };
    w.AnalyticsManager = { record: (name, data) => calls.events.push({ name, data }) };
    w.AgentService = {
        getModelList: () => calls.models,
        addEntry: entry => { calls.models.push(entry); return entry; },
        _syncBrainToEntry: async () => {}
    };
    w.eval(read('js/core/license-claim.js'));
    w.eval(read('js/core/app-manager.js') + '\nwindow.AppManager = AppManager;');
    w.AppManager._clearInitialLoader = () => {};
    w.AppManager.showSetup();
    const el = id => w.document.getElementById(id);
    return { dom, w, calls, el, submit: () => el('setup-registration').dispatchEvent(new w.Event('submit', { cancelable: true })) };
}

(async () => {
    let s = setup();
    await tick();
    s.submit(); await tick();
    assert.equal(s.calls.emails.length, 0, 'blank email never crosses IPC');
    s.el('setup-email').value = 'not-an-email';
    s.submit(); await tick();
    assert.equal(s.calls.emails.length, 0);
    assert.equal(s.calls.completed, 0);
    assert.equal(s.el('setup-email').getAttribute('aria-invalid'), 'true');
    assert.equal(s.el('setup-skip-btn'), null, 'registration has no skip path');
    s.dom.window.close();

    s = setup();
    await tick();
    s.el('setup-model-change').click();
    s.w.document.querySelector('[data-model="cloud:nenva-cloud-pro"]').click();
    assert.equal(s.calls.emails.length, 0, 'model choice alone does not register');
    s.el('setup-email').value = 'pro@example.com';
    s.submit(); await tick();
    assert.equal(s.calls.models[0].model, 'nenva-cloud-pro', 'registration preserves the chosen model');
    assert.equal(s.calls.emails.length, 1, 'pro requires registration too');
    s.dom.window.close();

    let resolveClaim;
    s = setup({ claim: () => new Promise(resolve => { resolveClaim = resolve; }) });
    await tick();
    s.el('setup-email').value = 'user@example.com';
    s.submit(); s.submit();
    assert.equal(s.calls.emails.length, 1, 'double submit sends one claim');
    assert.equal(s.calls.completed, 0, 'await license before marking setup done');
    assert.equal(s.el('setup-start-btn').disabled, true);
    resolveClaim(success); await tick();
    assert.equal(s.calls.completed, 1);
    assert.equal(s.w.LicenseClaim.isLicensed(), true);
    assert.ok(s.w.localStorage.getItem('license.nudgedAt'), 'do not repeat registration nudge');
    assert.deepEqual(JSON.parse(JSON.stringify(s.calls.events.find(e => e.name === 'license.claimed'))), {
        name: 'license.claimed', data: { class: 'free' }
    }, 'no address in analytics');
    assert.equal(s.calls.models[0].model, 'nenva-cloud-lite');
    s.dom.window.close();

    for (const fail of [async () => ({ error: 'Service unavailable' }), async () => { throw Error('IPC failed'); }, async () => null]) {
        let failing = true;
        s = setup({ claim: () => failing ? fail() : Promise.resolve(success) });
        await tick();
        s.el('setup-email').value = 'retry@example.com';
        s.submit(); await tick();
        assert.equal(s.calls.completed, 0);
        assert.equal(s.el('setup-email').value, 'retry@example.com');
        assert.equal(s.el('setup-start-btn').disabled, false);
        assert.equal(s.el('setup-skip-btn'), null, 'failed claim cannot bypass registration');
        assert.ok(s.el('setup-registration-status').textContent);
        failing = false;
        s.submit(); await tick();
        assert.equal(s.calls.completed, 1, 'retry succeeds');
        s.dom.window.close();
    }

    let failSetup = true;
    s = setup({ complete: async () => { if (failSetup) throw Error('disk error'); } });
    await tick();
    s.el('setup-email').value = 'saved@example.com';
    s.submit(); await tick();
    assert.equal(s.calls.completed, 0);
    assert.match(s.el('setup-registration-status').textContent, /license is saved/);
    assert.equal(s.el('setup-email').disabled, true, 'retry retains the registered address');
    failSetup = false;
    s.submit(); await tick();
    assert.equal(s.calls.completed, 1);
    assert.equal(s.calls.emails.length, 1, 'setup retry does not reclaim a saved license');
    s.dom.window.close();
    console.log('setup-registration-test: all assertions passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
