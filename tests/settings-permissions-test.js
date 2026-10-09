// Permission settings must show exact scopes and preserve bounds unless edited.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

async function run() {
    const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
    const source = new JSDOM(html);
    const dom = new JSDOM(source.window.document.getElementById('llm-sec-permissions').outerHTML, { runScripts: 'outside-only' });
    source.window.close();
    const w = dom.window;
    const end = new Date(Date.now() + 10 * 86400000 + 12345).toISOString();
    let persisted;
    w.electronPermissions = {
        getGrants: async () => [
            { id: 'files', tool: 'fs:read', scope: '/Users/person/<private>/a-long-folder-name/Tax returns', createdAt: '2026-10-01' },
            { id: 'mail', tool: 'send_email', budget: 4, expiresAt: end, exclusions: ['new_recipient'], createdAt: '2026-10-02' }
        ],
        setGrants: async grants => { persisted = JSON.parse(JSON.stringify(grants)); }
    };
    let s;
    w.AppManager = { register(name, app) { s = app; } };
    w.UIUtils = { escapeHtml: value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'), showToast() {} };
    for (const file of ['js/agent/permission-manager.js', 'js/apps/settings/settings-app.js']) {
        w.eval(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'));
    }
    const pm = w.PermissionManager;
    const list = w.document.getElementById('settings-agent-permissions-list');
    const row = id => list.querySelector(`[data-grant="${id}"]`);
    await s._loadAgentPermissions();
    assert.equal(row('files').querySelector('.agent-perm-detail').textContent, '/Users/person/<private>/a-long-folder-name/Tax returns');
    assert.equal(list.querySelector('private'), null, 'scopes are text, never markup');
    assert.match(row('mail').textContent, /Known email recipients only/);
    assert.match(row('mail').textContent, /0 of 4 uses today/);
    const search = w.document.getElementById('settings-agent-permissions-search');
    const clear = w.document.getElementById('settings-agent-permissions-clear');
    const noResults = w.document.getElementById('settings-agent-permissions-no-results');
    const filter = query => { search.value = query; search.dispatchEvent(new w.Event('input')); };
    const section = name => Array.from(w.document.querySelectorAll('[data-permission-section]')).find(b => b.dataset.permissionSection === name);
    assert.equal(section('').textContent.trim(), 'All 2');
    assert.equal(section('Files & folders').textContent.trim(), 'Files & folders 1');
    section('Files & folders').click();
    assert.equal(row('files').hidden, false);
    assert.equal(row('mail').hidden, true, 'section selection narrows the list');
    assert.equal(section('Files & folders').getAttribute('aria-pressed'), 'true');
    filter('email');
    assert.equal(noResults.hidden, false, 'search combines with the selected section');
    section('').click();
    assert.equal(row('mail').hidden, false);
    filter('  TAX returns  ');
    assert.equal(row('files').hidden, false, 'search is case insensitive and finds full paths');
    assert.equal(row('mail').closest('.agent-perm-group').hidden, true, 'empty sections hide');
    filter('nothing-matches');
    assert.equal(noResults.hidden, false);
    assert.equal(list.textContent.includes('No saved permissions'), false, 'no matches is distinct from no grants');
    clear.click();
    assert.equal(row('files').hidden, false);
    assert.equal(row('mail').hidden, false);
    assert.equal(noResults.hidden, true);
    assert.equal(w.document.activeElement, search);
    assert.equal(persisted, undefined, 'search and sections never mutate permissions');

    row('mail').querySelector('[data-limit]').click();
    let form = row('mail').querySelector('form');
    form.querySelector('[data-budget]').value = '2';
    filter('files');
    clear.click();
    assert.equal(row('mail').querySelector('form'), form, 'filtering preserves unfinished edits');
    assert.equal(form.querySelector('[data-budget]').value, '2');
    form.querySelector('[data-cancel]').click();
    assert.equal(pm.listGrants()[1].budget, 4, 'Cancel never writes');
    assert.equal(w.document.activeElement, row('mail').querySelector('[data-limit]'));

    row('mail').querySelector('[data-limit]').click();
    form = row('mail').querySelector('form');
    form.querySelector('[data-budget]').value = '-1';
    assert.equal(form.checkValidity(), false, 'negative limits are rejected');
    form.querySelector('[data-budget]').value = '2';
    filter('email');
    await form.onsubmit({ preventDefault() {} });
    assert.equal(search.value, 'email', 'saving preserves the query');
    assert.equal(row('files').hidden, true);
    assert.equal(persisted[1].budget, 2);
    assert.equal(persisted[1].expiresAt, end, 'budget edit preserves the exact end date');
    assert.deepEqual(persisted[1].exclusions, ['new_recipient'], 'editing limits preserves recipient restrictions');

    row('mail').querySelector('[data-limit]').click();
    form = row('mail').querySelector('form');
    form.querySelector('[data-budget]').value = '';
    form.querySelector('[data-days]').value = '';
    await form.onsubmit({ preventDefault() {} });
    assert.equal(persisted[1].budget, undefined, 'blank clears the daily cap');
    assert.equal(persisted[1].expiresAt, undefined, 'explicitly clearing days clears expiry');

    row('mail').querySelector('[data-limit]').click();
    form = row('mail').querySelector('form');
    form.querySelector('[data-days]').value = '7';
    await form.onsubmit({ preventDefault() {} });
    assert.ok(Math.abs(Date.parse(persisted[1].expiresAt) - Date.now() - 7 * 86400000) < 1000);
    filter('tax');
    await row('files').querySelector('[data-revoke]').onclick();
    assert.equal(row('files'), null);
    assert.equal(persisted.length, 1, 'only the selected permission is removed');
    assert.equal(search.value, 'tax');
    assert.equal(noResults.hidden, false, 'removing the last matching result retains the search');
    assert.equal(w.document.activeElement, search, 'focus never moves into a hidden result');
    clear.click();
    await row('mail').querySelector('[data-revoke]').onclick();
    assert.equal(persisted.length, 0);
    assert.match(list.textContent, /No saved permissions/);
    assert.match(list.textContent, /Always allow/);
    assert.equal(w.document.getElementById('settings-agent-permissions-search-wrap').hidden, true);
    dom.window.close();
    console.log('settings-permissions: scopes, cancel, validation, bounds, expiry and removal passed');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
