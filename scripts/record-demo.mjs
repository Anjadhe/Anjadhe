#!/usr/bin/env node
/*
 * Record the seeded demo walkthrough as video frames, via CDP screencast.
 * Runs on the shared story driver (scripts/demo-stories/demo-lib.mjs).
 * No dependencies beyond Node >= 21 (built-in WebSocket) and a running
 * demo instance. Full recipe (see docs/DEMO.md §5):
 *
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/seed-demo-data.js ~/AnjadheDemo --baked --force
 *   ANJADHE_DATA_ROOT=~/AnjadheDemo ./node_modules/.bin/electron . \
 *       --remote-debugging-port=9333 \
 *       --disable-backgrounding-occluded-windows --disable-renderer-backgrounding &
 *   node scripts/record-demo.mjs /tmp/demo-frames
 *   ffmpeg -f concat -safe 0 -i /tmp/demo-frames/concat.txt \
 *       -vf "scale=1400:-2,format=yuv420p" -r 30 -c:v libx264 -crf 18 \
 *       -movflags +faststart anjadhe-demo.mp4
 *
 * The two --disable-backgrounding flags are load-bearing: macOS stops the
 * document timeline (and so compositing, and so screencast frames) when
 * the window is occluded — a recording without them silently freezes the
 * moment another window covers the app (same root cause as the
 * "motion may move content, never reveal it" animation rule).
 *
 * The video narrates ITSELF: title slides and lower-third captions are
 * baked into the frames (docs/DEMOS.md holds the canonical text — keep
 * the two in sync). No voiceover; background music is added in post.
 *
 * Walkthrough: Home → live ask → Email AI (insight, Bills, Trips, trip
 * view) → Inbox (Needs reply, a message + its insight panel, Waiting on
 * them) → Tasks (complete one, confetti) → Goals → Routines → Portfolio
 * → closing slide. Re-seed before every take: the walkthrough mutates
 * state (a completed task, read marks).
 */
import { Demo, sleep, CLOSING } from './demo-stories/demo-lib.mjs';

const OUT = process.argv[2] || 'demo-frames';

const d = await new Demo().init();
await d.prep();
await d.placeWindow();
await d.settleEmail(120000);
// The feed beats show the Daily Briefing and the review posts, and the
// boot catch-up digests (briefing + strategy/goal reviews) run serially
// through one queue — wait for it to drain BEFORE frames start, or the
// briefing beat records against a feed that does not have it yet.
console.log('waiting for boot digests (briefing + reviews)…');
await d.E(`RoutineEngine.retryNow?.(); RoutineEngine.tick?.();`);
await d.waitFor(`((RoutineEngine.local || JSON.parse(localStorage.getItem('routine-state') || '{}')).queue || []).length === 0`, 420000, 'digest queue clear');
await d.waitFor(`(StorageManager.get('notes')?.notes || []).some(n => n.feed && n.feed.promptId === 'starter-daily-briefing' && !n.feed.error)`, 60000, 'briefing post exists');
await d.inject();

const S = (n, f) => d.step(n, f);

/**
 * Go home and open a routine's newest feed post in the reading overlay —
 * the "its review is already waiting in the feed" beat each feature ends
 * on. Camera-clicks the series head; falls back to opening by note id.
 */
const showFeedPost = async (titleRx, caption, hold = 3600) => {
    await d.E(`AppManager.showDashboard(); document.querySelector('.dash-main')?.scrollTo({top: 0});`);
    await sleep(1000);
    await d.E(`
        const rx = new RegExp(${JSON.stringify(titleRx)}, 'i');
        const notes = StorageManager.get('notes')?.notes || [];
        const routine = notes.find(n => n.template === 'prompt' && rx.test(n.title || ''));
        if (!routine) throw new Error('no routine matching ' + ${JSON.stringify(titleRx)});
        const post = notes
            .filter(n => n.feed && n.feed.promptId === routine.id && !n.feed.error)
            .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))[0];
        if (!post) throw new Error('no feed post yet for ' + routine.title);
        const head = __demo.find('.feed-series-head[data-feed-open]', routine.title);
        if (head) { await __demo.clickEl(head); await new Promise(r => setTimeout(r, 700)); }
        const ov = document.querySelector('.feed-post-overlay');
        if (!ov || ov.hidden) PromptFeed.openPost(post.id);`);
    await d.cap(caption, hold);
    await d.E(`
        const b = __demo.find('.feed-post-overlay .feed-post-back', null);
        if (b) await __demo.clickEl(b); else PromptFeed.closePost();`);
    await d.cap(null);
    await sleep(500);
};

await d.record(OUT);

/* ---- choreography ----------------------------------------------------- */
await S('opening slide', () => d.slide('This is Anjadhe',
    'A personal assistant that lives on your Mac. Your calendar, mail, money, and plans in one place.', 4200, { logo: true }));
await S('home start', async () => {
    await d.E(`AppManager.showDashboard(); document.querySelector('.dash-main')?.scrollTo({top: 0});`);
    await d.cap('This is home. Widgets for what needs you today, written from your own data.', 2200);
});
await S('zoom: email widget', async () => {
    await d.cap('Like the mail that actually needs you, already read and picked out.');
    await d.zoomIn('#dash-widgets .widget-card[data-widget="email-insights"]', null, { scale: 1.55, holdMs: 2800 });
});
await S('home feed peek', async () => {
    await d.cap('The feed below fills itself. A morning briefing, the news you follow, reviews of your goals and your money. Written by routines, not by you.');
    await d.E(`document.querySelector('.dash-main')?.scrollTo({top: 620, behavior: 'smooth'});`);
    await sleep(2600);
    await d.E(`document.querySelector('.dash-main')?.scrollTo({top: 0, behavior: 'smooth'});`);
    await sleep(1000);
});
// Live assistant beat — only meaningful when a model is configured (the
// Anjadhe Cloud take). With no model the send would error; skip cleanly.
await S('ask the assistant (live)', async () => {
    const hasModel = await d.c.evaluate('!!AgentService.model');
    if (!hasModel) throw new Error('no model configured — skipping live ask');
    // Re-home unconditionally: if an earlier beat SKIPped mid-scroll, the
    // composer would otherwise be out of the viewport.
    await d.E(`AppManager.showDashboard(); document.querySelector('.dash-main')?.scrollTo({top: 0});`);
    await sleep(700);
    await d.cap('Ask it anything. Here: what should I focus on today?');
    await d.askAndWait('What should I focus on today?', 90000, { zoom: 1.45 });
    await d.cap('It reads your actual schedule, links the real tasks, and gives you an honest answer.', 4200);
    await d.cap(null);
    await d.click('#agent-close-btn', null, 600);
    await sleep(600);
});
await S('chapter: mail', () => d.slide('Your mail, already read', '', 2400));
await S('open Email AI', async () => {
    await d.click('#app-sidenav [data-app="fyi"]', null, 1200);
    await d.cap('Every incoming email gets read and filed. Bills, renewals, receipts, each with the facts pulled out.', 3000);
});
await S('open first coming-up insight', async () => {
    await d.click('#fyi-view [data-fyi-goto]', null, 800);
    await d.cap('Each one opens into the full story: what it is, what it costs, what to do.', 3000);
});
await S('back to overview', async () => {
    await d.click('#fyi-view .back-btn', null, 600);
    await sleep(1000);
});
await S('Bills folder', async () => {
    await d.click('#fyi-view [data-fyi-type="bill"]', null, 800);
    await d.cap('Bills, with amounts and due dates taken from the mail itself.', 2400);
});
await S('Trips index', async () => {
    await d.click('#fyi-view [data-fyi-bundle="trips"]', null, 800);
    await d.cap('Booking emails cluster into trips on their own.', 2200);
});
await S('Seattle trip view', async () => {
    await d.E(`
        const el = __demo.find('#fyi-view [data-fyi-trip], #fyi-view .fyi-trip-row, #fyi-view [data-fyi-goto], #fyi-view .fyi-row', 'Seattle')
              || __demo.find('#fyi-view a, #fyi-view button, #fyi-view [role="button"], #fyi-view div', 'Marlowe');
        if (!el) throw new Error('no Seattle row');
        await __demo.clickEl(el);`);
    await d.cap('Two booking emails became a trip. Flight out, hotel, flight back. Nobody typed this.', 3200);
});
await S('to Inbox', async () => {
    await d.click('#fyi-inbox-btn', null, 1200);
    await d.cap('The inbox knows which threads need you.', 2000);
});
await S('Needs reply', async () => {
    await d.click('.email-label-item[data-label="REPLY"]', null, 800);
    await d.cap('Needs reply: real people, waiting on you.', 2200);
});
await S('open Dana message', async () => {
    await d.E(`
        const el = __demo.find('#email-view [data-message-id], #email-view .email-item, #email-view .email-row', 'Roadmap deck');
        if (!el) throw new Error('no Dana row');
        await __demo.clickEl(el);`);
    await sleep(3200);
});
await S('Waiting on them', async () => {
    await d.click('.email-label-item[data-label="WAITING"]', null, 800);
    await d.cap('And the people who owe you an answer.', 2400);
});
await S('chapter: day', () => d.slide('Your day, finishable', '', 2400));
await S('open Tasks', async () => {
    await d.click('#app-sidenav [data-app="actions"]', null, 1000);
    await d.cap('Your day is a short, finishable list. Some of these came straight from your mail.', 2400);
});
await S('complete credit card task', async () => {
    // Click the INPUT, never its wrapping label: a label click bubbles with
    // target=label, misses the delegation's closest('.actions-check') early
    // return, and falls through to the row handler — completing the task
    // AND opening its editor.
    await d.E(`
        const check = [...document.querySelectorAll('#actions-view input.actions-check')]
            .find(el => el.closest('li, .actions-row, [data-id]')?.textContent.includes('Pay the credit card bill'));
        if (!check) throw new Error('no check for task');
        // Dive onto the row, tick it while zoomed (clicks land fine — rects
        // are post-transform), hold for the confetti, pull back.
        const row = check.closest('.actions-row, li, [data-id]') || check;
        if (!row.id) row.id = '__demo-zoom-target';
        await __demo.zoomIn('#' + row.id, null, 1.5);
        await __demo.clickEl(check);
        await new Promise(r => setTimeout(r, 2400));
        await __demo.zoomOut();`);
    await sleep(500);
});
await S('feed: the Daily Briefing', () => showFeedPost('^Daily Briefing$',
    'Your day was already written up this morning. The Daily Briefing waits on the home feed.', 3600));
await S('open Goals', async () => {
    await d.click('#app-sidenav [data-app="goals"]', null, 1000);
    await d.cap('Behind the tasks: goals, with real plans and dates.', 2600);
});
await S('open 10K goal', () => d.openGoal('run a 10k'));
await S('goal weekly review', async () => {
    await d.cap('A review is scheduled on this goal. Every week, Anjadhe reads the real progress and writes an honest read.');
    try {
        await d.zoomIn('#goals-view .ai-review-quote', null, { scale: 1.5, holdMs: 3200 });
    } catch (e) {
        await d.E(`
            const q = __demo.find('#goals-view h3, #goals-view h4, #goals-view div', 'review');
            q?.scrollIntoView({block:'center', behavior:'smooth'});
            await __demo.holdLive(3200);`);
    }
});
await S('feed: the goal review', () => showFeedPost('^Goal Review:',
    'And here it is, back on the home feed. Anjadhe read the plan and wrote this on its own.', 3600));
await S('chapter: routines', () => d.slide('It works while you don’t', '', 2400));
await S('open Routines', async () => {
    await d.click('#app-sidenav [data-app="prompts"]', null, 1000);
    await d.cap('Routines are standing instructions. They run on a schedule, or when something happens.', 2600);
});
await S('open a routine detail', async () => {
    await d.E(`
        const el = __demo.find('#prompts-view .routines-table tbody tr, #prompts-view .routines-table tr', 'resume')
              || __demo.find('#prompts-view .routines-table tbody tr', 'LinkedIn')
              || __demo.find('#prompts-view .routines-table tbody tr', 'Morning');
        if (!el) throw new Error('no routine row');
        await __demo.clickEl(el);`);
    await d.cap('This one waits for a job alert email, then drafts a tailored resume from the real one.', 3000);
});
await S('open Writing Voices', async () => {
    await d.click('#app-sidenav [data-app="library"]', null, 1200);
    await d.cap('It can even write like you. Give Anjadhe documents you wrote, and it studies how you sound.', 2800);
});
await S('the studied voice', async () => {
    await d.E(`
        const row = __demo.find('.library-voice-row', 'My voice');
        if (!row) throw new Error('no voice row');
        await __demo.clickEl(row);`);
    await sleep(1400);
    await d.cap('It studied three pieces Emily wrote. What it learned is a style guide you can read, and edit.');
    try {
        await d.zoomIn('.library-voice-body', null, { scale: 1.4, holdMs: 3800 });
    } catch (e) {
        await d.E(`await __demo.holdLive(3400);`);
    }
});
await S('voice exemplars', async () => {
    await d.cap('Real passages from her own writing anchor it, quoted verbatim. Nothing hidden, nothing invented.');
    try {
        await d.zoomIn('.library-voice-ex', null, { scale: 1.45, holdMs: 3400 });
    } catch (e) {
        await d.E(`await __demo.holdLive(3000);`);
    }
});
await S('voice everywhere', async () => {
    await d.cap('From here on, anything Anjadhe writes for you, a draft, a post, even a routine’s digest, can come out in this voice.', 3200);
});
await S('open Portfolio', async () => {
    await d.click('#app-sidenav [data-app="portfolio"]', null, 1200);
    await d.cap('Your money too. Accounts, holdings, and the plan behind them.', 2200);
});
await S('strategy: the plan, computed', async () => {
    await d.E(`
        const nav = __demo.find('#portfolio-nav button, #portfolio-nav a, #portfolio-nav li, #portfolio-nav div', 'Strategy')
              || document.querySelector('.portfolio-strategy-line');
        if (!nav) throw new Error('no strategy door');
        await __demo.clickEl(nav);`);
    await sleep(1000);
    await d.cap('The plan is written down, and whether you are on it is computed from your real holdings.');
    try {
        await d.zoomIn('.strategy-verdict, .strategy-mix-row', null, { scale: 1.5, holdMs: 3200 });
    } catch (e) {
        await d.E(`
            document.querySelector('.strategy-verdict, .strategy-mix-row')?.scrollIntoView({block:'center', behavior:'smooth'});
            await __demo.holdLive(3200);`);
    }
});
await S('feed: the strategy review', () => showFeedPost('^Strategy Review:',
    'A routine reviews that plan every weekday morning, and it waits on the home feed with the rest. Your day, your goals, your money, all reviewed before you sat down.', 4000));
await S('home close', async () => {
    await d.E(`document.querySelector('.dash-main')?.scrollTo({top: 0, behavior: 'smooth'});`);
    await sleep(1600);
});
await S('closing slide', () => d.slide('Private by default',
    'The AI runs on your Mac by default, or Anjadhe Cloud, a server you own, or a provider you trust with your own key.', 4200, CLOSING));

await d.stop();
d.c.close();
process.exit(0);
