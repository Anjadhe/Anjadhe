#!/usr/bin/env node
/*
 * Capture marketing screenshots of the app for the website.
 *
 * Seeds a throwaway --baked demo data root (Priya Raman persona, tidy
 * inbox, pre-baked insights), launches the real app on it, walks the key
 * views, and writes retina PNGs into the website repo:
 *
 *   node scripts/capture-screenshots.js            # -> ../anjadhe-website/public/screenshots
 *   node scripts/capture-screenshots.js <outDir>   # -> custom folder
 *
 * Re-run after UI changes so the site never shows a stale UI. Never
 * touches real data. Requires the repo's electron + playwright-core.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { _electron } = require('playwright-core');

const REPO = path.resolve(__dirname, '..');
const OUT = path.resolve(process.argv[2] || path.join(REPO, '..', 'anjadhe-website', 'public', 'screenshots'));
const ELECTRON_BIN = path.join(REPO, 'node_modules', '.bin', 'electron');
const DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'anjadhe-shots-'));

fs.mkdirSync(OUT, { recursive: true });

console.log('Seeding baked demo root: ' + DATA_ROOT);
execFileSync(ELECTRON_BIN, [path.join(REPO, 'scripts', 'seed-demo-data.js'), DATA_ROOT, '--force', '--baked'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: 'ignore',
});

// Staging fixes applied before every shot: close first-visit help modals,
// hide the setup-progress card, and make the composer's model chip read
// like a configured machine instead of "No model" (which is only true of
// this throwaway root, not of a set-up install).
async function stage(page) {
    await page.evaluate(() => {
        document.querySelectorAll('dialog, .modal-overlay').forEach((d) => {
            try { d.close && d.close(); } catch (e) {}
            d.remove();
        });
        document.querySelectorAll('button, span, div').forEach((el) => {
            if (el.childElementCount === 0 && el.textContent.trim() === 'No model') {
                const wrap = el.closest('span') || el;
                wrap.style.display = 'none';
            }
        });
        document.querySelectorAll('button').forEach((el) => {
            if (el.textContent.trim() === 'choose model') el.textContent = 'qwen3:14b';
        });
        document.querySelectorAll('.setup-assistant, .setup-assistant-strip').forEach((el) => el.remove());
        // The model readiness dot reads "offline" in this throwaway root;
        // hide it rather than show a red dot in marketing shots.
        document.querySelectorAll('[class*="readiness"]').forEach((el) => { el.style.display = 'none'; });
        // The fresh root's version always matches the newest What's-new
        // entry, so the chip photobombs every shot.
        document.querySelectorAll('.whats-new-chip').forEach((el) => el.remove());
    });
    await page.waitForTimeout(300);
}

(async () => {
    const app = await _electron.launch({
        executablePath: path.join(REPO, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron'),
        args: [REPO],
        cwd: REPO,
        env: { ...process.env, ANJADHE_DATA_ROOT: DATA_ROOT },
    });
    const page = await app.firstWindow();
    await page.waitForTimeout(4500);

    // Mark every first-visit help topic as seen so no modal photobombs.
    await page.evaluate(() => {
        try { StorageManager.set('help-seen', { ids: (HelpApp.TOPICS || []).map((t) => t.id) }); } catch (e) {}
    });

    const shot = async (name) => {
        await stage(page);
        await page.screenshot({ path: path.join(OUT, name + '.png') });
        console.log('  captured ' + name + '.png');
    };

    // Home feed
    await shot('home-feed');

    // Actions: Today
    await page.evaluate(() => AppManager.openApp('actions'));
    await page.waitForTimeout(1500);
    await shot('actions-today');

    // Email AI (the fyi app) — insights left the Email app 2026-08-02;
    // the overview briefing is the shot.
    await page.evaluate(() => AppManager.openApp('fyi'));
    await page.waitForTimeout(2000);
    await shot('email-insights');

    // Inbox with bundles (Email opens on it since the insights page went)
    await page.evaluate(() => AppManager.openApp('email'));
    await page.waitForTimeout(2000);
    await page.evaluate(() => document.querySelector('[data-filter="all"], .email-view-toggle [data-mode="all"]')?.click());
    await page.waitForTimeout(500);
    await shot('email-inbox');

    await app.close();

    // Downscale to 1600px wide (still crisp at ~800px display width on
    // retina) so the site stays light. macOS sips; skipped elsewhere.
    if (process.platform === 'darwin') {
        for (const f of fs.readdirSync(OUT).filter((n) => n.endsWith('.png'))) {
            execFileSync('sips', ['--resampleWidth', '1600', path.join(OUT, f)], { stdio: 'ignore' });
        }
        console.log('Downscaled to 1600px wide.');
    }

    fs.rmSync(DATA_ROOT, { recursive: true, force: true });
    console.log('Screenshots written to ' + OUT);
})().catch((e) => {
    fs.rmSync(DATA_ROOT, { recursive: true, force: true });
    console.error(e);
    process.exit(1);
});
