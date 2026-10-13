#!/usr/bin/env node
/**
 * Smoke for the simulation layer in the REAL app (docs/THREADS_DEMO.md "The
 * simulation layer"): an Electron/Playwright harness run by hand, never from
 * npm test. Seeds a throwaway root with the threads-demo scenario, launches
 * with ANJADHE_SIM=1, turns texts on, plays the scenario's texts and one
 * later email, and checks that each walked the app's own door:
 *   - a played text became an IMessageSource record (chat.db's path);
 *   - a played email is in EmailApp.emails, persisted, and queued for
 *     analysis (the Gmail syncs' path, EmailApp.receiveEmails).
 * No model is needed: ingestion stops at the analysis queue.
 *
 *   node tests/sim-sources-smoke.cjs            # root: ~/AnjadheThreadsDemo (re-seeded)
 */
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { _electron } = require('playwright-core');

const REPO = path.resolve(__dirname, '..');
const ROOT = process.env.SIM_ROOT || path.join(os.homedir(), 'AnjadheThreadsDemo');
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
    execFileSync(path.join(REPO, 'node_modules', '.bin', 'electron'),
        [path.join(REPO, 'scripts', 'seed-demo-data.js'), ROOT, '--scenario', 'threads-demo', '--force'],
        { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'ignore' });
    const app = await _electron.launch({
        executablePath: path.join(REPO, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron'),
        args: [REPO, '--use-mock-keychain'], cwd: REPO,
        env: { ...process.env, ANJADHE_DATA_ROOT: ROOT, ANJADHE_SIM: '1', ANJADHE_EMBED_OFF: '1' }
    });
    const page = await app.firstWindow();
    const fails = [];
    const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) fails.push(what); };
    try {
        await wait(3000);
        await page.evaluate(() => window.electronStore.markSetupComplete());
        await page.evaluate(() => localStorage.setItem('imessage-insights', '1'));
        await page.reload();
        await wait(5000);

        const st = await page.evaluate(() => window.electronSim.status());
        check(st && st.active === true, 'simulation is active on the test root');
        const on = await page.evaluate(() => SimSources.active);
        check(on === true, 'renderer half is on');

        const before = await page.evaluate(() => ({ emails: EmailApp.emails.length, texts: Object.keys(IMessageSource._ensureData().records).length }));
        const played = await page.evaluate(() => SimSources.play('threads-demo', { upTo: 0 }));
        check(played.ok && played.steps.includes('M0.text') && played.steps.includes('D0.text'), `played the past texts: ${JSON.stringify(played.steps)}`);
        await wait(2500);
        const texts = await page.evaluate(() => Object.values(IMessageSource._ensureData().records).map(r => r.from));
        check(texts.some(f => /Alvarez/.test(f)) && texts.some(f => /Bright Smile/.test(f)), `texts became records: ${JSON.stringify(texts)}`);

        // A spy on the queue's door: with no model the drain fails the analysis
        // at once and the id leaves the queue, so "queued" must be seen as it happens.
        await page.evaluate(() => { window.__queued = []; const q = EmailApp.queueEmailsForAnalysis.bind(EmailApp); EmailApp.queueEmailsForAnalysis = (list) => { window.__queued.push(...list.map(e => e.messageId)); return q(list); }; });
        const one = await page.evaluate(() => SimSources.play('threads-demo', { step: 'A4.lakeside', at: '0d 10:05' }));
        check(one.ok && one.steps[0] === 'A4.lakeside', 'played one later email now');
        await wait(2500);
        const after = await page.evaluate(() => {
            const e = EmailApp.emailById('A4.lakeside');
            return { has: !!e, from: e && e.from, count: EmailApp.emails.length,
                queued: (window.__queued || []).includes('A4.lakeside'),
                gates: e ? { ai: EmailApp.aiInsightsEnabled, metered: EmailApp._meteredInsights(), autoDetect: !!(EmailApp.insightSettings || {}).autoDetect, consider: EmailApp.shouldConsiderForAnalysis(e), incoming: EmailApp._isIncoming(e) } : null };
        });
        check(after.has && /Lakeside/.test(after.from || ''), 'the email is in EmailApp.emails');
        check(after.count === before.emails + 1, `one new email (${before.emails} → ${after.count})`);
        check(after.queued, `the email reached the analysis queue (or was analysed); gates ${JSON.stringify(after.gates)}`);
        const persisted = await page.evaluate(async () => { const r = await window.electronEmailDb.get('A4.lakeside'); return !!r; });
        check(persisted, 'the email is persisted in the mailbox');
        const again = await page.evaluate(() => SimSources.play('threads-demo', { step: 'A4.lakeside', at: '0d 10:05' }));
        await wait(1000);
        const count2 = await page.evaluate(() => EmailApp.emails.length);
        check(again.ok && count2 === after.count, 'the same message again is merged, not duplicated');
    } catch (e) {
        console.error('smoke crashed:', e);
        fails.push('crash');
    } finally {
        await app.close().catch(() => {});
    }
    console.log(fails.length ? `\nFAILED: ${fails.length}` : '\nsim-sources-smoke: ok');
    process.exit(fails.length ? 1 : 0);
})();
