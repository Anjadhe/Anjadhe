// Optional real extension + Native Messaging fixture. All profiles and cookies
// are throwaway; no user accounts, external websites or normal Chrome profile.
'use strict';
const { chromium } = require('playwright-core');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict'), http = require('node:http');
const { ChromeRuntime } = require('../js/main/browser/chrome-runtime');
const { spawn } = require('node:child_process');
const WorkroomBrowser = require('../js/main/workroom-browser');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'anjadhe-chrome-fixture-')), repo = path.resolve(__dirname, '..');
const executable = process.env.ANJADHE_TEST_CHROME || chromium.executablePath();
const values = new Map([['workroom-browser-engine', 'chrome']]);
const settings = { get: (key, fallback) => values.has(key) ? values.get(key) : fallback, set: (key, value) => values.set(key, value) };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async predicate => { const deadline = Date.now() + 20000; while (!await predicate()) { if (Date.now() > deadline) throw new Error('Timed out waiting for fixture state'); await delay(100); } };
const leases = new Map([['room', { sender: 1, token: 'fixture' }]]);
const asked = [];
const store = { leases, get: () => ({ status: leases.size ? 'running' : 'paused' }), snapshot: () => [{ id: 'room', status: leases.size ? 'running' : 'paused' }],
    requestApproval: async (id, token, sender, request) => { asked.push(request); return { approved: true }; } };
const runtime = new ChromeRuntime({ userData: root, source: path.join(repo, 'browser-extension'), operations: path.join(repo, 'js/main/browser/page-operations.js'), settings, executable,
    hostCommand: config => [process.execPath, path.join(repo, 'js/main/browser/native-host.js'), config] });
const browser = new WorkroomBrowser({ store: () => store, settings, chrome: runtime });
const run = { id: 'room', token: 'fixture' };
const look = (image = false) => browser.execute(1, { action: 'look', run, image });
const act = (args, image = false) => browser.execute(1, { action: 'act', args, run, image }).catch(error => { error.message += ' [during ' + JSON.stringify(args) + ']'; throw error; });
const byLabel = (observed, label) => observed.elements.find(el => el.label === label);
(async () => {
    const server = http.createServer((req, res) => {
        if (req.url === '/slow-image') { const timer = setTimeout(() => res.end(), 12000); req.on('close', () => clearTimeout(timer)); return; }
        if (req.url === '/login') { res.writeHead(302, { 'Set-Cookie': 'fixture_login=yes; Max-Age=86400; HttpOnly; Path=/', Location: '/' }); res.end(); return; }
        res.setHeader('Content-Type', 'text/html');
        if (req.url.startsWith('/results')) { res.end('<html><title>Results</title><h1>The Odyssey at Dublin CA</h1><a href="/popup" target="_blank">Open booking</a></html>'); return; }
        if (req.url === '/long') { res.end('<html><title>Long</title><body><h1>Top</h1><button>Top button</button><div style="height:3000px"></div><p>Deep target</p><p id="out">Not clicked</p><button onclick="document.getElementById(\'out\').textContent = \'Deep clicked trusted=\' + event.isTrusted">Deep button</button></body></html>'); return; }
        if (req.url === '/shop') { res.end('<html><title>Shop</title><body><h1>Cart</h1><button onclick="document.body.append(\'Ordered\')">Place order</button></body></html>'); return; }
        if (req.url === '/popup') { res.end('<html><title>Booking fixture</title><h1>Booking page</h1></html>'); return; }
        res.end(`<html><title>Chrome fixture</title><body>${req.url === '/slow-page' ? '<img src="/slow-image">' : ''}<h1>${req.headers.cookie?.includes('fixture_login=yes') ? 'Signed in' : 'Signed out'}</h1><form action="/results" role="search"><label>Theater<select name="theater" aria-label="Theater"><option value="ny">New York</option><option value="dublin">Dublin CA</option></select></label><label>Movie<input type="search" name="q"></label><button>Find movie</button></form><input type="password" aria-label="Password"><button onclick="document.getElementById('status').textContent='Clicked'">Inspect</button><p id="status">Ready</p></body></html>`);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}/`;
    let context, background;
    const launch = async () => {
        await runtime.prepare();
        context = await chromium.launchPersistentContext(runtime.profile, { executablePath: executable, headless: false,
            args: ['--disable-extensions-except=' + runtime.extension, '--load-extension=' + runtime.extension] });
        context.on('serviceworker', worker => worker.on('console', message => console.log('extension:', message.text())));
        await until(() => runtime.state().connected);
        console.log('Connected real extension/native host');
    };
    try {
        await launch();
        const blank = await look();
        assert.equal(blank.blocker, undefined, 'An empty Chrome tab must allow the agent to open a site, not require the user');
        assert.match(blank.error, /Open a website/);
        let observed = await act({ action: 'open', url });
        assert.equal(asked.length, 1, 'The first step on a new website asks once');
        assert.equal(asked[0].kind, 'site');
        assert.match(observed.text, /Signed out/);
        assert.ok(observed.elements.every(el => Number.isInteger(el.n)), 'Controls are numbered');
        const pwd = byLabel(observed, 'Password');
        assert.equal(pwd.manualOnly, true);
        const refused = await act({ action: 'type', n: pwd.n, text: 'not-entered' });
        assert.match(refused.step?.error || refused.error, /Only the user/);
        observed = await look();
        const stale = byLabel(observed, 'Inspect').n;
        observed = await act({ action: 'click', n: stale }); assert.match(observed.text, /Clicked/);
        assert.equal(asked.length, 1, 'Later steps on the same website do not ask again');
        observed = await act({ action: 'select', n: byLabel(observed, 'Theater').n, text: 'dublin' });
        assert.equal(observed.step?.error, undefined, JSON.stringify(observed.step));
        observed = await act({ action: 'type', n: byLabel(observed, 'Movie').n, text: 'Odyssey', submit: true });
        assert.match(observed.url, /theater=dublin/); assert.match(observed.text, /The Odyssey at Dublin CA/);
        observed = await act({ action: 'back' }); assert.match(observed.text, /Signed out/);
        observed = await act({ action: 'open', url: url + 'results' });
        observed = await act({ action: 'click', n: byLabel(observed, 'Open booking').n });
        assert.match(observed.text, /Booking page/);
        // Looking at the window is not taking it over; PRESSING the page is.
        // The press is swallowed either way — the page never gets it behind the
        // agent's back — and the team pauses only when it was meant for the page.
        const human = context.pages().find(page => page.url().startsWith(url));
        assert.match(await human.locator('[data-anjadhe-shield]').textContent(), /Anjadhe is working here.*Take control/);
        assert.ok(!(await look()).elements.some(el => /Take control/.test(el.label)), 'The pill is not part of the page the agent reads');
        await human.locator('h1').click({ force: true });
        await until(() => runtime.state().control === 'human');
        await until(async () => !(await human.locator('[data-anjadhe-shield]').count()));
        observed = await act({ action: 'open', url: url + 'results' });
        assert.equal(runtime.state().control, 'agent', 'Continue puts the agent back at the wheel');
        observed = await act({ action: 'click', n: byLabel(observed, 'Open booking').n });
        assert.match(observed.text, /Booking page/);
        const watching = await browser.view('room'); assert.equal(watching.status, 'live'); assert.match(watching.image, /^data:image\/jpeg;base64,/);
        assert.equal(watching.control, 'agent'); assert.ok(watching.viewport.w > 0);
        await assert.rejects(async () => browser.input('room', { type: 'text', text: 'x' }), /Take control first/, 'The user cannot type while the agent is driving');
        const visual = await look(true);
        assert.equal(visual.imageError, undefined, visual.imageError);
        assert.match(visual.images[0].dataUrl, /^data:image\/jpeg;base64,/);
        assert.match(visual.text, /Booking page/);
        assert.ok(visual.images[0].dataUrl.length < 850000);
        observed = await act({ action: 'open', url: url + 'long' });
        assert.ok(observed.more.below > 0, 'Controls below the viewport are counted, not listed');
        assert.ok(!byLabel(observed, 'Deep button'), 'A look is the viewport');
        observed = await act({ action: 'find', text: 'Deep target' });
        assert.equal(observed.step.found, 1);
        assert.ok(byLabel(observed, 'Deep button'), 'find brings the text and its control into view');
        observed = await act({ action: 'click', n: byLabel(observed, 'Deep button').n });
        assert.match(observed.text, /Deep clicked trusted=true/, 'A click the page can trust: ' + JSON.stringify([observed.step, observed.text.slice(-80)]));
        observed = await act({ action: 'press', key: 'Escape' });
        assert.equal(observed.step?.error, undefined);
        const buy = byLabel(await act({ action: 'open', url: url + 'shop' }), 'Place order');
        const before = asked.length;
        await act({ action: 'click', n: buy.n });
        assert.equal(asked.length, before + 1, 'A buying step asks every time, even on an allowed website');
        assert.equal(asked.at(-1).kind, 'step'); assert.ok(asked.at(-1).sensitive);
        const started = Date.now();
        observed = await act({ action: 'open', url: url + 'slow-page' });
        assert.ok(Date.now() - started < 5000, 'Subresource loading must not consume the 8-second document wait');
        observed = await act({ action: 'click', n: byLabel(observed, 'Inspect').n });
        assert.match(observed.text, /Clicked/, 'Fresh controls remain usable while an image loads');
        await act({ action: 'open', url: url + 'popup' });
        console.log('Open, look, numbered controls, protected fields, search, select, back, popup, find, trusted click, asks-every-time and preview live view and explicit take-control passed');
        // Taking control is ONE explicit act: the pill's own button.
        const shielded = context.pages().find(page => page.url().includes('/popup'));
        await shielded.locator('[data-anjadhe-shield] button').click();
        await until(() => runtime.state().control === 'human');
        await until(async () => !(await shielded.locator('[data-anjadhe-shield]').count()));
        leases.set('room', { sender: 1, token: 'fixture' });
        await act({ action: 'open', url: url + 'popup' });
        assert.equal(runtime.state().control, 'agent', 'Continue puts the agent back at the wheel');
        await until(async () => !!(await shielded.locator('[data-anjadhe-shield]').count()));
        const pending = assert.rejects(browser.execute(1, { action: 'act', args: { action: 'wait', ms: 1500 }, run }), /control|paused|no longer active/);
        await delay(100); leases.clear(); await runtime.takeover();
        await pending;
        // The user's hands, from the chat: click a field, type, paste. Including the
        // password field the AGENT is never allowed to touch.
        const page = context.pages().find(page => page.url().includes('/popup'));
        await page.goto(url);
        const driving = await browser.view('room'); assert.equal(driving.status, 'live'); assert.equal(driving.control, 'human');
        const centre = async selector => page.evaluate(sel => { const r = document.querySelector(sel).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, selector);
        const tap = async at => { await browser.input('room', { type: 'mouse', action: 'down', ...at, button: 0, clickCount: 1 }); await browser.input('room', { type: 'mouse', action: 'up', ...at, button: 0, clickCount: 1 }); };
        const press = async key => { const keyCode = key.toUpperCase().charCodeAt(0); await browser.input('room', { type: 'key', action: 'down', key, code: 'Key' + key.toUpperCase(), keyCode }); await browser.input('room', { type: 'key', action: 'up', key, code: 'Key' + key.toUpperCase(), keyCode }); };
        await tap(await centre('input[name=q]')); await press('h'); await press('i');
        await browser.input('room', { type: 'text', text: ' there' });
        assert.equal(await page.inputValue('input[name=q]'), 'hi there');
        await tap(await centre('input[type=password]')); await press('p'); await press('w');
        assert.equal(await page.inputValue('input[type=password]'), 'pw', 'The user can enter what the agent never may');
        assert.equal(runtime.state().control, 'human', 'Our own forwarded events are not mistaken for a second takeover');
        await assert.rejects(async () => browser.input('other', { type: 'text', text: 'x' }), /not using the browser/);
        await page.goto(url + 'login');
        assert.match(await page.locator('h1').textContent(), /Signed in/);
        await context.close(); context = null; await until(() => !runtime.state().connected);
        runtime.close();
        await launch();
        leases.set('room', { sender: 1, token: 'fixture' });
        observed = await act({ action: 'open', url }); assert.match(observed.text, /Signed in/);
        console.log('Takeover discards in-flight results; fixture login survives Chrome and bridge restart');
        await context.close(); context = null; await until(() => !runtime.state().connected);
        // Test-only unpacked installation flag: Playwright's initial extension
        // loading is temporary. Production relies on the user's one-time install
        // and does NOT add --load-extension or automation flags.
        let launches = 0;
        runtime.spawnChrome = async options => {
            assert.equal(options.background, true); launches++;
            background = spawn(executable, ['--user-data-dir=' + runtime.profile, '--no-first-run', '--no-default-browser-check', '--no-startup-window', '--load-extension=' + runtime.extension,
                '--password-store=basic', '--use-mock-keychain'], { stdio: 'ignore' }); // Match Playwright's test-only cookie encryption.
            await new Promise((resolve, reject) => { background.once('spawn', resolve); background.once('error', reject); });
        };
        await Promise.all([runtime.ensure(), runtime.ensure()]); assert.equal(launches, 1);
        observed = await act({ action: 'open', url }); assert.match(observed.text, /Signed in/);
        console.log('A closed Chrome starts without a startup window, reconnects once, and retains fixture login');
    } finally {
        if (context) await context.close();
        if (background && background.exitCode === null) { const exited = new Promise(resolve => background.once('exit', resolve)); background.kill(); await exited; }
        runtime.close(); server.close(); fs.rmSync(root, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
