#!/usr/bin/env node
/*
 * Record a REAL assistant interaction as a video clip for the website:
 * seeds a baked demo root, copies this machine's model config, launches
 * the app, types the question into the assistant (visibly), and captures
 * frames while the local model generates. Frames are assembled into an
 * mp4 played faster than real time (the clip caption on the site should
 * say it's sped up).
 *
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron \
 *     scripts/capture-assistant-video.js --model=gemma4:12b \
 *     --ffmpeg=/path/to/ffmpeg "Question to ask"
 *
 * Output: ../anjadhe-website/public/videos/assistant-demo.mp4 (+ poster
 * png alongside). ffmpeg is required; pass --ffmpeg= or have it on PATH
 * (e.g. from an ffmpeg-static install).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const Database = require('better-sqlite3');
const { _electron } = require('playwright-core');

const REPO = path.resolve(__dirname, '..');
const OUT_DIR = path.join(REPO, '..', 'anjadhe-website', 'public', 'videos');
const args = process.argv.slice(2);
const MODEL = (args.find((a) => a.startsWith('--model=')) || '').replace('--model=', '') || null;
const FFMPEG = (args.find((a) => a.startsWith('--ffmpeg=')) || '').replace('--ffmpeg=', '') || 'ffmpeg';
// The full story: plan the trip in conversation, then have the agent
// create the goal + dated tasks, and end on the Actions app showing them.
const MESSAGES = args.filter((a) => !a.startsWith('--'));
if (MESSAGES.length === 0) {
    MESSAGES.push(
        'Plan a family trip to New York in early December for us. How long should we go, where should we stay, what are the must-see places with a 7-year-old, and what do we need to book in advance?',
        'Perfect. Create a goal for this trip, and add all the booking and preparation tasks to it with due dates so I can track everything in Actions.'
    );
}
const TARGET_SECONDS = 38; // playback speed adapts so the clip stays short

const ELECTRON_BIN = path.join(REPO, 'node_modules', '.bin', 'electron');
const DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'anjadhe-agent-video-'));
const FRAMES = fs.mkdtempSync(path.join(os.tmpdir(), 'anjadhe-frames-'));

function cleanup() {
    fs.rmSync(DATA_ROOT, { recursive: true, force: true });
    fs.rmSync(FRAMES, { recursive: true, force: true });
}

console.log('Seeding baked demo root: ' + DATA_ROOT);
execFileSync(ELECTRON_BIN, [path.join(REPO, 'scripts', 'seed-demo-data.js'), DATA_ROOT, '--force', '--baked'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: 'ignore',
});

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
        console.error('--model=' + MODEL + ' not found: ' + (cfg.modelList || []).map((m) => m.model).join(', '));
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

(async () => {
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

    // Mark every first-visit help topic as seen so no "Got it" modal
    // photobombs a shot (they pop per app/tab on first open).
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

    // Frame recorder: jpeg frames as fast as the loop allows (~2/s).
    let frame = 0;
    let recording = true;
    const recordStart = Date.now();
    const recorder = (async () => {
        while (recording) {
            const name = path.join(FRAMES, 'f' + String(frame).padStart(5, '0') + '.jpg');
            try {
                await page.screenshot({ path: name, type: 'jpeg', quality: 85 });
                frame += 1;
            } catch (e) { /* window busy; skip frame */ }
            await new Promise((r) => setTimeout(r, 250));
        }
    })();

    // Type a message visibly, send it, and wait until the model finishes.
    // Tool-permission modals ("Confirm action" / Allow) are auto-approved
    // at the next poll tick, so they appear on screen briefly: the
    // permission model is part of the story.
    const started = Date.now();
    async function sendAndWait(text) {
        await page.click('#agent-app-input');
        await page.keyboard.type(text, { delay: 16 });
        await page.waitForTimeout(400);
        await page.evaluate(() => document.getElementById('agent-app-send-btn').click());
        let sawGenerating = false;
        let lastLen = -1;
        let stableTicks = 0;
        const turnStart = Date.now();
        while (Date.now() - turnStart < 8 * 60 * 1000) {
            await page.waitForTimeout(1500);
            const s = await page.evaluate(() => {
                const allow = Array.from(document.querySelectorAll('.agent-confirm-dialog button, dialog button'))
                    .find((b) => b.textContent.trim() === 'Allow');
                if (allow) allow.click();
                return {
                    btn: (document.getElementById('agent-app-send-btn') || {}).textContent || '',
                    len: (document.getElementById('agent-app-messages') || {}).innerHTML?.length || 0,
                    clickedAllow: !!allow,
                };
            });
            if (s.clickedAllow) console.log('  approved a tool permission ask');
            const generating = !s.btn.includes('↑');
            if (generating) sawGenerating = true;
            if (sawGenerating && !generating) {
                if (s.len === lastLen) {
                    stableTicks += 1;
                    if (stableTicks >= 2) break;
                } else stableTicks = 0;
            }
            lastLen = s.len;
        }
    }

    for (const [i, msg] of MESSAGES.entries()) {
        console.log('Turn ' + (i + 1) + ': ' + msg.slice(0, 60) + '...');
        await sendAndWait(msg);
        await page.waitForTimeout(2000); // hold the finished answer
    }

    // Did the agent actually create the goal and its tasks? Small local
    // models are nondeterministic about the second half; if the tasks are
    // missing, nudge once, the way a real user would.
    const checkCreated = () => page.evaluate(() => {
        const goals = (StorageManager.get('goals')?.goals || []).filter((g) => /york|nyc/i.test(g.title));
        const gid = goals.map((g) => g.id);
        const links = (StorageManager.get('links')?.links || []);
        const taskIds = links.filter((l) => l.sourceApp === 'goals' && gid.includes(l.sourceId) && l.targetApp === 'schedule').map((l) => l.targetId);
        const items = (StorageManager.get('schedule')?.scheduleItems || []);
        return {
            goals: goals.map((g) => g.title),
            linkedTasks: items.filter((t) => taskIds.includes(t.id)).map((t) => t.title + ' @ ' + t.scheduledDate),
        };
    });
    let created = await checkCreated();
    console.log('Agent created: ' + JSON.stringify(created, null, 1));
    if (created.goals.length > 0 && created.linkedTasks.length < 2) {
        console.log('Tasks missing; sending a corrective nudge turn...');
        await sendAndWait('I don\'t see the tasks under the goal yet. Please add each booking task (flights, hotel, Broadway tickets, ferry) as separate tasks under that goal, each with a due date.');
        await page.waitForTimeout(2000);
        created = await checkCreated();
        console.log('After nudge: ' + JSON.stringify(created, null, 1));
    }

    // Finale: the created goal and tasks, in Actions › Plan.
    try {
        await page.evaluate(() => AppManager.openApp('actions'));
        await page.waitForTimeout(1500);
        await page.evaluate(() => {
            document.querySelectorAll('dialog, .modal-overlay').forEach((d) => {
                try { d.close && d.close(); } catch (e) {}
                d.remove();
            });
        });
        await page.evaluate(() => {
            const plan = Array.from(document.querySelectorAll('button'))
                .find((b) => b.textContent.trim() === 'Plan');
            if (plan) plan.click();
        });
        await page.waitForTimeout(1500);
        // Drill into the new goal via the app's own navigation, so the
        // detail pane shows its dated tasks.
        const openedGoal = await page.evaluate(() => {
            const g = (StorageManager.get('goals')?.goals || []).find((x) => /york|nyc/i.test(x.title));
            if (!g || typeof FocusApp === 'undefined') return false;
            FocusApp.selectNode('goal', g.id);
            return true;
        });
        if (!openedGoal) console.warn('Could not find the New York goal to open.');
        await page.waitForTimeout(5000); // hold the finale on the task list
    } catch (e) {
        console.warn('Finale navigation failed: ' + e.message);
    }

    recording = false;
    await recorder;
    const capturedFps = frame / ((Date.now() - recordStart) / 1000);
    await app.close();
    console.log('Captured ' + frame + ' frames in ' + Math.round((Date.now() - started) / 1000) + 's.');

    fs.mkdirSync(OUT_DIR, { recursive: true });
    const outMp4 = path.join(OUT_DIR, 'assistant-demo.mp4');
    // Playback speed adapts to keep the clip near TARGET_SECONDS.
    const PLAY_FPS = Math.min(16, Math.max(6, Math.ceil(frame / TARGET_SECONDS)));
    execFileSync(FFMPEG, [
        '-y',
        '-framerate', String(PLAY_FPS),
        '-i', path.join(FRAMES, 'f%05d.jpg'),
        '-vf', 'scale=1400:-2',
        '-c:v', 'libx264',
        '-preset', 'slow',
        '-crf', '26',
        '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart',
        '-an',
        outMp4,
    ], { stdio: 'ignore' });

    // Poster: the final frame, for the video element's first paint.
    const lastFrame = path.join(FRAMES, 'f' + String(frame - 1).padStart(5, '0') + '.jpg');
    fs.copyFileSync(lastFrame, path.join(OUT_DIR, 'assistant-demo-poster.jpg'));

    const mb = (fs.statSync(outMp4).size / 1024 / 1024).toFixed(1);
    const speed = (PLAY_FPS / capturedFps).toFixed(1);
    console.log('Wrote ' + outMp4 + ' (' + mb + ' MB, ' + Math.round(frame / PLAY_FPS) + 's at ~' + speed + 'x speed)');
    cleanup();
})().catch((e) => {
    cleanup();
    console.error(e);
    process.exit(1);
});
