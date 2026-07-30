#!/usr/bin/env node
/*
 * Capture a REAL assistant interaction for the website: seeds a baked
 * demo root, copies this machine's model config into it (config only,
 * no personal data), launches the app, asks the assistant a question
 * over the demo persona's data, waits for the local model to finish,
 * and writes the finished conversation as a screenshot.
 *
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/capture-assistant-shot.js ["Question to ask"]
 *
 * Slow by design (the local model actually runs). Needs llama.cpp
 * models installed (~/.anjadhe_llamacpp) and a model configured in the
 * real install.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const Database = require('better-sqlite3');
const { _electron } = require('playwright-core');

const REPO = path.resolve(__dirname, '..');
const OUT = path.join(REPO, '..', 'anjadhe-website', 'public', 'screenshots');
const args = process.argv.slice(2);
const MODEL = (args.find((a) => a.startsWith('--model=')) || '').replace('--model=', '') || null;
const QUESTION = args.find((a) => !a.startsWith('--')) || 'What should I focus on today?';
const ELECTRON_BIN = path.join(REPO, 'node_modules', '.bin', 'electron');
const DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'anjadhe-agent-shot-'));

console.log('Seeding baked demo root: ' + DATA_ROOT);
execFileSync(ELECTRON_BIN, [path.join(REPO, 'scripts', 'seed-demo-data.js'), DATA_ROOT, '--force', '--baked'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: 'ignore',
});

// Copy the real machine's agent settings (selected model + model list)
// so the demo instance can actually run the local model.
const realDb = new Database(path.join(os.homedir(), 'Library', 'Application Support', 'Anjadhe', 'anjadhe-app-data.db'), { readonly: true });
const agentSettings = realDb.prepare('SELECT value FROM kv WHERE key = ?').get('app_agent-settings');
realDb.close();
if (!agentSettings) {
    console.error('No app_agent-settings in the real install; select a model in the app first.');
    process.exit(1);
}
let settingsValue = agentSettings.value;
if (MODEL) {
    const cfg = JSON.parse(settingsValue);
    const entry = (cfg.modelList || []).find((m) => (m.model || '').startsWith(MODEL));
    if (!entry) {
        console.error('--model=' + MODEL + ' not found in the real install\'s model list: ' + (cfg.modelList || []).map((m) => m.model).join(', '));
        process.exit(1);
    }
    cfg.selectedModel = entry.model;
    if (entry.id) cfg.defaultModelId = entry.id;
    settingsValue = JSON.stringify(cfg);
    console.log('Model override: ' + entry.model);
}
const demoDb = new Database(path.join(DATA_ROOT, 'userData', 'anjadhe-app-data.db'));
demoDb.prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)').run('app_agent-settings', settingsValue);
demoDb.close();
console.log('Model config copied. Asking: "' + QUESTION + '"');

(async () => {
    // This script runs under ELECTRON_RUN_AS_NODE (better-sqlite3 ABI);
    // the launched app must not inherit that or it starts as node.
    const appEnv = { ...process.env, ANJADHE_DATA_ROOT: DATA_ROOT };
    delete appEnv.ELECTRON_RUN_AS_NODE;
    const app = await _electron.launch({
        executablePath: path.join(REPO, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron'),
        args: [REPO],
        cwd: REPO,
        env: appEnv,
    });
    const page = await app.firstWindow();
    await page.waitForTimeout(4500);

    // Mark every first-visit help topic as seen so no modal photobombs.
    await page.evaluate(() => {
        try { StorageManager.set('help-seen', { ids: (HelpApp.TOPICS || []).map((t) => t.id) }); } catch (e) {}
    });

    await page.evaluate(() => AppManager.openApp('agent'));
    await page.waitForTimeout(2000);
    await page.evaluate(() => {
        document.querySelectorAll('dialog, .modal-overlay').forEach((d) => {
            try { d.close && d.close(); } catch (e) {}
            d.remove();
        });
    });

    await page.evaluate((q) => {
        const input = document.getElementById('agent-app-input');
        input.value = q;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        document.getElementById('agent-app-send-btn').click();
    }, QUESTION);
    console.log('Sent. Waiting for the model (this can take a few minutes)...');

    // The send button shows a stop glyph while generating and returns to
    // the up-arrow when done. Wait for that round-trip, then for the
    // message DOM to stop changing.
    const started = Date.now();
    let sawGenerating = false;
    let lastLen = -1;
    let stableTicks = 0;
    while (Date.now() - started < 8 * 60 * 1000) {
        await page.waitForTimeout(2000);
        const s = await page.evaluate(() => ({
            btn: (document.getElementById('agent-app-send-btn') || {}).textContent || '',
            len: (document.getElementById('agent-app-messages') || {}).innerHTML?.length || 0,
        }));
        const generating = !s.btn.includes('↑');
        if (generating) sawGenerating = true;
        if (sawGenerating && !generating) {
            if (s.len === lastLen) {
                stableTicks += 1;
                if (stableTicks >= 2) break;
            } else {
                stableTicks = 0;
            }
        }
        lastLen = s.len;
    }
    if (!sawGenerating) console.warn('Warning: never saw a generating state; capturing whatever is on screen.');
    await page.waitForTimeout(1000);

    // Nudge the scroll up a touch so the tool-steps line above the answer
    // isn't clipped at the top edge of the frame.
    await page.evaluate(() => {
        const m = document.getElementById('agent-app-messages');
        if (m) m.scrollTop = Math.max(0, m.scrollTop - 70);
    });
    await page.waitForTimeout(300);

    fs.mkdirSync(OUT, { recursive: true });
    const outFile = path.join(OUT, 'assistant-chat.png');
    await page.screenshot({ path: outFile });
    await app.close();

    if (process.platform === 'darwin') {
        execFileSync('sips', ['--resampleWidth', '1600', outFile], { stdio: 'ignore' });
    }
    fs.rmSync(DATA_ROOT, { recursive: true, force: true });
    console.log('Captured ' + outFile + ' in ' + Math.round((Date.now() - started) / 1000) + 's');
})().catch((e) => {
    fs.rmSync(DATA_ROOT, { recursive: true, force: true });
    console.error(e);
    process.exit(1);
});
