/* The Workrooms page in the REAL app, isolated profile, scripted model.
 * node tests/workrooms-electron-test.cjs [--shots DIR]
 * Only inference and the browser bridge are stubbed; main's store, the IPC
 * deltas, the engine and the UI are the real ones. */
const { _electron } = require('playwright-core');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict');
const repo = path.resolve(__dirname, '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'anjadhe-workrooms-ui-'));
const shots = process.argv.includes('--shots') ? process.argv[process.argv.indexOf('--shots') + 1] : null;
fs.mkdirSync(path.join(root, 'userData'));
fs.writeFileSync(path.join(root, 'userData/anjadhe-app-settings.json'), JSON.stringify({ setupComplete: true, syncEnabled: false }));
(async () => {
    const env = { ...process.env, ANJADHE_DATA_ROOT: root, ANJADHE_EMBED_OFF: '1' }; delete env.ELECTRON_RUN_AS_NODE;
    const app = await _electron.launch({ executablePath: require('electron'), args: [repo], cwd: repo, env });
    try {
        const page = await app.firstWindow(); page.setDefaultTimeout(15000);
        const errors = []; page.on('pageerror', error => errors.push(error.message));
        await page.waitForFunction(() => typeof AppManager !== 'undefined' && document.querySelector('.view.active'));
        await page.waitForTimeout(1200);
        await page.evaluate(() => { localStorage.setItem('simple-experience', 'off'); FEATURES.setOverride('workrooms', true); });
        await page.reload(); await page.waitForSelector('#workrooms-view', { state: 'attached' });
        await page.waitForFunction(() => typeof WorkroomEngine !== 'undefined' && WorkroomsApp._inited);
        await page.evaluate(() => {
            AgentService._kickBackgroundAI = () => {}; AgentService.model = 'scripted';
            AgentService.ensureVisionInfo = async () => {}; AgentService.supportsVision = () => false;
            window.__script = []; window.__seen = [];
            LLMLogger.call = async (source, params) => { window.__seen.push(params); const next = window.__script.shift(); if (!next) return { error: 'HTTP 400 script ran out' }; if (next.waitFor) await new Promise(resolve => { window[next.waitFor] = resolve; }); return next.reply; };
        });
        const say = text => ({ reply: { message: { content: text } } });
        const use = (name, args, extra = {}) => ({ reply: { message: { content: '', tool_calls: [{ function: { name, arguments: JSON.stringify(args) } }] } }, ...extra });
        await page.evaluate(() => AppManager.openApp('workrooms'));
        await page.waitForSelector('.wr-welcome');
        assert.equal(await page.locator('.wr-head').count(), 0, 'A new chat is a blank thread and a composer, nothing else');
        assert.equal(await page.locator('.wr-invite').count(), 4);
        await page.click('.wr-invite >> nth=0');
        assert.match(await page.inputValue('.wr-composer textarea'), /kettle/, 'An invite puts its words in the composer');
        if (shots) await page.screenshot({ path: path.join(shots, 'wr-1-new.png') });

        // A plain ask: one bubble out, one bubble back.
        await page.evaluate(script => { window.__script = script; }, [say('**Crumb & Co.** has a nice ring to it.')]);
        await page.fill('.wr-composer textarea', 'Name my bakery'); await page.keyboard.press('Enter');
        await page.waitForSelector('.wr-msg[data-from="master"]');
        assert.equal(await page.locator('.wr-msg').count(), 2);
        assert.equal(await page.locator('.wr-msg.is-me .wr-plain').textContent(), 'Name my bakery');
        assert.match(await page.locator('.wr-msg[data-from="master"] .wr-prose').innerHTML(), /<strong>Crumb/, 'Replies render as prose');
        await page.waitForFunction(() => document.getElementById('wr-typing').hidden, null, { timeout: 5000 });
        assert.equal(await page.locator('.wr-room').count(), 1);
        assert.match(await page.locator('.wr-room-preview').textContent(), /Crumb/);

        // A delegated job: the agent joins, "is typing", reports under its own name.
        await page.evaluate(script => { window.__script = script; }, [
            use('delegate', { agent: 'research', task: 'Find the Aero kettle price, with a link.' }),
            { ...use('web_search', { query: 'Aero kettle price' }), waitFor: '__goSearch' },
            say('It is $34 at https://shop.example.test/p/aero'), say('The Aero kettle is $34.')]);
        await page.evaluate(() => { AgentTools.handlers.web_search = async () => ({ results: [{ title: 'Aero', url: 'https://shop.example.test/p/aero', snippet: '$34' }] }); });
        await page.fill('.wr-composer textarea', 'How much is the Aero kettle?'); await page.keyboard.press('Enter');
        await page.waitForFunction(() => /Research is reading the brief/.test(document.getElementById('wr-typing')?.textContent || ''));
        assert.match(await page.locator('#wr-sub').textContent(), /You, nenva, Research/);
        assert.equal(await page.locator('#wr-stop').textContent(), 'Stop');
        if (shots) await page.screenshot({ path: path.join(shots, 'wr-2-working.png') });
        await page.evaluate(() => window.__goSearch());
        await page.waitForFunction(() => document.querySelectorAll('.wr-msg[data-from="master"]').length === 2);
        assert.match(await page.locator('.wr-line').first().textContent(), /Research joined/);
        assert.match(await page.locator('.wr-msg[data-from="research"] .wr-name').textContent(), /Research/);
        assert.match(await page.locator('.wr-msg[data-from="research"] .wr-sources a').textContent(), /shop\.example\.test/);
        assert.equal(await page.locator('.wr-thread .wr-steps, .wr-thread pre').count(), 0, 'Tool activity is not in the conversation');
        // …it is one tap away.
        await page.click('.wr-msg[data-from="research"] .wr-name');
        await page.waitForSelector('#wr-panel .wr-steps li');
        assert.match(await page.locator('#wr-panel .wr-steps li').first().textContent(), /searching the web for .Aero kettle price./);
        if (shots) await page.screenshot({ path: path.join(shots, 'wr-3-agent-panel.png') });
        await page.click('[data-wr="back-info"]');
        assert.equal(await page.locator('#wr-panel .wr-members li').count(), 3);
        assert.equal(await page.locator('#wr-panel [data-wr="delete"]').count(), 1, 'Setup, permissions and delete live behind group info');
        if (shots) await page.screenshot({ path: path.join(shots, 'wr-4-info.png') });
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('#wr-panel').isHidden(), true);

        // An approval is a message with quick replies. MAIN asks (covered by
        // workroom-browser-test and the Chrome harness); here, what it looks like.
        await page.evaluate(() => {
            const room = { ...WorkroomsApp.room(), status: 'running', now: { agent: 'browser', text: '' } };
            const approval = { id: 'a1', agent: 'browser', kind: 'site', origin: 'https://shop.example.test', summary: 'Work on shop.example.test?', detail: 'First step: Open https://shop.example.test/.' };
            const seq = WorkroomsApp._events.get(room.id).at(-1).seq;
            WorkroomsApp.onDelta({ room: { ...room, members: ['research', 'browser'] }, event: { seq: seq + 1, at: new Date().toISOString(), type: 'join', agent: 'browser' } });
            WorkroomsApp.onDelta({ room: { ...room, members: ['research', 'browser'], approval, seq: seq + 2 }, event: { seq: seq + 2, at: new Date().toISOString(), type: 'approval', ...approval } });
        });
        await page.waitForSelector('.wr-ask .wr-replies');
        assert.deepEqual(await page.locator('.wr-replies button').allTextContents(), ['Yes', 'Always on this site', 'No']);
        assert.match(await page.locator('.wr-ask-q').textContent(), /Work on shop\.example\.test\?/);
        assert.match(await page.locator('#wr-typing').textContent(), /Browser is waiting for your answer/);
        assert.match(await page.locator('.wr-room .wr-badge.is-word').textContent(), /Asking you/);
        assert.equal(await page.locator('.wr-ask pre').count(), 0, 'No raw JSON in a question');
        if (shots) await page.screenshot({ path: path.join(shots, 'wr-5-approval.png') });
        await page.evaluate(() => {
            const room = WorkroomsApp.room(), seq = WorkroomsApp._events.get(room.id).at(-1).seq;
            WorkroomsApp.onDelta({ room: { ...room, approval: null }, event: { seq: seq + 1, at: new Date().toISOString(), type: 'approval_answer', id: 'a1', approved: true, always: false, by: 'you' } });
        });
        await page.waitForFunction(() => !document.querySelector('.wr-replies'));
        assert.match(await page.locator('.wr-line').last().textContent(), /You said yes/);
        // What an agent did is said IN the thread: a live ticker, then one line.
        assert.match(await page.locator('.wr-ticker-done').first().textContent(), /1 step .* see what it did/);
        // The browser opens beside the chat, wide, with the way to drive it.
        await page.evaluate(() => { WorkroomsApp._panel = { agent: 'browser' }; WorkroomsApp.renderPanel(WorkroomsApp.room()); });
        await page.waitForSelector('.wr-panel.is-wide .wr-view-screen');
        assert.deepEqual(await page.locator('.wr-view-actions button').allTextContents(), ['Take control', 'Open in Chrome']);
        assert.equal(await page.locator('.wr-list').isVisible(), false, 'The chat list steps aside for the browser');
        if (shots) await page.screenshot({ path: path.join(shots, 'wr-7-browser.png') });
        // One type scale: every size on the page is one of the declared five.
        const sizes = await page.evaluate(() => [...new Set([...document.querySelectorAll('.wr-shell *')].filter(el => el.childNodes.length && [...el.childNodes].some(n => n.nodeType === 3 && n.nodeValue.trim())).map(el => getComputedStyle(el).fontSize))].sort());
        assert.ok(sizes.length <= 5, 'Type sizes in use: ' + sizes.join(', '));
        await page.evaluate(() => { WorkroomsApp._panel = null; WorkroomsApp.renderPanel(WorkroomsApp.room()); });
        // Dark theme, and a narrow window.
        if (shots) {
            await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
            await page.waitForTimeout(400); // colour transitions settle
            await page.screenshot({ path: path.join(shots, 'wr-6-dark.png') });
        }
        assert.deepEqual(errors, [], 'No page errors: ' + errors.join(' | '));
        console.log('workrooms-electron-test passed');
    } finally { await app.close().catch(() => {}); fs.rmSync(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
