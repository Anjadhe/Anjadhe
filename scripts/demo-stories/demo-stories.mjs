// Per-story demo choreographies. Usage: node demo-stories.mjs <story> <framesDir>
// Stories: email | goal | routine | memory | voice
import { Demo, sleep, CLOSING } from './demo-lib.mjs';

const story = process.argv[2];
const outDir = process.argv[3];
if (!story || !outDir) { console.error('usage: node demo-stories.mjs <email|goal|routine|memory|voice> <framesDir>'); process.exit(1); }

const d = await new Demo().init();
await d.prep();
await d.placeWindow();
await d.settleEmail(story === 'email' ? 180000 : 120000);
await d.inject();

const S = (n, f) => d.step(n, f);
const home = async (ms = 2200) => { await d.E(`AppManager.showDashboard(); document.querySelector('.dash-main')?.scrollTo({top:0});`); await sleep(ms); };
// Wait out a model turn that was started by a page pill (askWithPrompt).
const waitTurn = (maxMs = 120000) => d.E(`
    const lastRole = () => {
        const cs = AgentService.conversations || [];
        const arr = Array.isArray(cs) ? cs : Object.values(cs);
        const c0 = arr.find(x => x.id === AgentService.activeConversationId) || arr[0];
        const msgs = c0?.messages || [];
        return msgs.length ? msgs[msgs.length - 1].role : null;
    };
    const t0 = Date.now();
    let quiet = 0;
    while (Date.now() - t0 < ${maxMs}) {
        const streaming = (AgentService.getActiveStreamingConvIds?.() || []).length > 0;
        const asking = !!document.querySelector('.agent-ask-card') || window.__demoBusy;
        if (!streaming && !asking && lastRole() === 'assistant' && Date.now() - t0 > 4000) { quiet += 1; if (quiet >= 3) break; }
        else quiet = 0;
        await new Promise(r => setTimeout(r, 850));
    }`).then(() => sleep(1200));

await d.record(outDir);

/* ================= STORY: my email works for me ======================== */
if (story === 'email') {
    await S('title slide', () => d.slide('Important things hide in email',
        'A bill due Friday. A renewal that went up. A trip you booked. Buried in a noisy inbox, waiting to be missed.'));
    await S('home', () => home(2200));
    await S('caption: widget', () => d.cap("Anjadhe already read this morning's mail. This widget shows only what actually needs you.", 2200));
    await S('point at email widget', async () => {
        await d.E(`
            const w = [...document.querySelectorAll('#dash-widgets > *')].find(x => x.textContent.includes('Email needs you'));
            if (!w) throw new Error('no email widget');
            const r = w.getBoundingClientRect();
            await __demo.moveTo(r.left + 120, r.top + 40);`);
        await sleep(1600);
    });
    await S('open widget insight', async () => {
        await d.cap('One click opens the full story behind any of them.');
        await d.E(`
            const card = document.querySelector('#dash-widgets .widget-card[data-widget="email-insights"]');
            if (!card) throw new Error('no email widget card');
            const btn = card.querySelector('.widget-row-btn[data-w-action="open"]') || card.querySelector('.widget-head[data-w-open]');
            await __demo.clickEl(btn);`);
        await sleep(1200);
        const inFyi = await d.c.evaluate(`AppManager.currentApp === 'fyi'`);
        if (!inFyi) await d.click('#app-sidenav [data-app="fyi"]', null, 800);
        await d.cap('This is Email AI. Every incoming email gets read and filed, automatically.', 2600);
    });
    await S('back to overview', async () => {
        try { await d.click('#fyi-view .back-btn', null, 600); } catch (e) { await d.click('#fyi-view [data-fyi-type=""], #fyi-view .fyi-nav-item', 'Overview', 600); }
        await d.cap('Bills, renewals, receipts, deliveries. Each in its own folder, with the facts pulled out.', 2400);
    });
    await S('Renewals folder (wow beat)', async () => {
        await d.click('#fyi-view [data-fyi-type="renewal"]', null, 800);
        await d.cap('This insurance premium quietly went up $38. The renewal date is already on the calendar.', 3400);
    });
    await S('Bills folder', async () => {
        await d.click('#fyi-view [data-fyi-type="bill"]', null, 800);
        await d.cap('Bills, with amounts and due dates taken from the mail itself.', 2400);
    });
    await S('Trips index + Seattle trip', async () => {
        await d.cap('Booking emails cluster into trips on their own.');
        await d.click('#fyi-view [data-fyi-bundle="trips"]', null, 800);
        await sleep(1600);
        await d.E(`
            const el = __demo.find('#fyi-view [data-fyi-trip], #fyi-view .fyi-trip-row, #fyi-view [data-fyi-goto], #fyi-view .fyi-row', 'Seattle')
                  || __demo.find('#fyi-view a, #fyi-view button, #fyi-view div', 'Marlowe');
            if (el) await __demo.clickEl(el);`);
        await d.cap('Two booking confirmations became one trip. Flight out, hotel, flight back. Nobody typed this.', 3200);
    });
    await S('to Inbox, Priority', async () => {
        await d.cap('The regular inbox is here too.');
        await d.click('#fyi-inbox-btn', null, 1200);
        await sleep(1000);
        await d.click('.email-label-item[data-label="PRIORITY"]', null, 800);
        await sleep(1400);
    });
    await S('open renewal mail + analysis', async () => {
        await d.E(`
            const el = __demo.find('#email-view [data-message-id], #email-view .email-item, #email-view .email-row', 'auto policy');
            if (!el) throw new Error('no renewal row');
            await __demo.clickEl(el);`);
        await sleep(1600);
        await d.cap('Under any message: what it means, and what to do about it.');
        await d.E(`document.getElementById('email-viewer-analysis')?.scrollIntoView({block:'center', behavior:'smooth'});`);
        await d.cap('The action item is a link. It already became a task.', 2800);
    });
    await S('follow action link to its task', async () => {
        await d.E(`
            const link = __demo.find('#email-view .insight-action-open, #email-view .insight-action-row a, #email-view [data-action-task]', null);
            if (!link) throw new Error('no action link');
            await __demo.clickEl(link);`);
        await d.cap('One click and you are on the task. Dated two days before the renewal, with the source email attached.', 3400);
    });
    await S('back to the message', async () => {
        await d.cap(null);
        await d.E(`
            const b = __demo.find('.back-btn, .breadcrumb-back, [data-back]', null);
            if (b) await __demo.clickEl(b); else AppManager.goBack?.();`);
        await sleep(1600);
    });
    await S('Tasks: email-derived items', async () => {
        await d.click('#app-sidenav [data-app="actions"]', null, 1000);
        await d.cap('Nothing to copy, nothing to remember. Your mail became your to-do list.', 3200);
    });
    await S('home close', async () => { await d.cap(null); await home(1600); });
    await S('closing slide', () => d.slide('Found, filed, and on your list',
        'Bills become dated tasks. Bookings become trips. A buried email stops being a missed deadline. Private by default.', 3600, CLOSING));
}

/* ================= STORY: set a goal in conversation =================== */
if (story === 'goal') {
    await S('title slide', () => d.slide('A goal without a plan is a wish',
        'You know what you want. The hard part is turning it into dated steps, and moving them all when life happens.'));
    await S('home', () => home(1800));
    await S('open Goals', async () => {
        await d.click('#app-sidenav [data-app="goals"]', null, 1000);
        await d.cap('Setting a goal here is a conversation. One button.', 2200);
    });
    await S('click "Help me set a new goal"', async () => {
        await d.click('[data-ask-new-goal]', null, 800);
        await d.cap('It interviews you. What you want, what done looks like, why it matters, when.');
        await waitTurn();
    });
    const answers = [
        'I want to learn conversational Spanish before our family trip to Puerto Vallarta in December.',
        'Done looks like: I can hold a ten-minute conversation and order a meal without switching to English.',
        "We're taking the kids to Puerto Vallarta in December and I want to actually talk with people there.",
        'Target date: December 10.',
        'Put it in the Learning group.',
        'Propose the plan for me — I can do 15 minutes on weekday evenings and one longer session on Saturdays.',
        'Work eats my evenings sometimes, so keep the daily practice short enough to survive a busy day.',
        'Yes — save the goal with those tasks and set up the weekly review.',
        'Yes, save it.',
    ];
    const saved = () => d.c.evaluate(`(() => (StorageManager.get('goals')?.goals || []).some(g => /spanish/i.test(g.title || '') && g.status !== 'draft'))()`);
    // Caption per interview phase, keyed to the answer about to be typed.
    const interviewCaps = {
        0: 'It interviews you. What you want, what done looks like, why it matters, when.',
        5: 'Then it proposes the plan. Short weekday sessions, a longer one on Saturdays, milestones with dates.',
        7: 'One approval saves the goal, its dated tasks, and a weekly review routine.',
    };
    for (let i = 0; i < answers.length; i++) {
        if (await saved()) { console.log('goal saved after', i, 'answers'); break; }
        if (interviewCaps[i]) await d.cap(interviewCaps[i]);
        await S('answer ' + (i + 1), () => d.askAndWait(answers[i], 120000, i === 0 ? { zoom: 1.45 } : {}));
    }
    await S('tidy leftover draft', async () => {
        // The interview sometimes leaves a mid-conversation draft behind
        // (saved under a different title, so merge-on-save missed it). Not
        // part of the story — clear it before the closing scenes.
        const n = await d.c.evaluate(`(() => {
            const blob = StorageManager.get('goals');
            const real = (blob.goals || []).some(g => /spanish/i.test(g.title || '') && g.status !== 'draft');
            if (!real) return 'no real goal — drafts left alone';
            const drafts = (blob.goals || []).filter(g => g.status === 'draft' && /spanish/i.test(g.title || ''));
            if (!drafts.length) return 0;
            blob.goals = blob.goals.filter(g => !drafts.some(x => x.id === g.id));
            StorageManager.set('goals', blob);
            return drafts.length;
        })()`);
        console.log('drafts removed:', n);
    });
    await S('bulk shift: push out two weeks', async () => {
        if (!(await saved())) throw new Error('goal never saved — skipping shift');
        await d.cap('Then life happens. One sentence reschedules the whole plan.');
        await d.capOnAsk('It shows exactly what will change before anything moves. You approve it.');
        await d.askAndWait('Work got crazy — push this whole plan out by two weeks, keep the weekday pattern.', 150000, { zoom: 1.45 });
        await d.capOnAsk(null);
    });
    await S('show the goal', async () => {
        await d.cap(null);
        await d.click('#app-sidenav [data-app="goals"]', null, 1000);
        await sleep(1200);
        await d.openGoal('spanish');
        await d.cap('The goal, in its group, with its plan and its review.', 2600);
    });
    await S('show the dated tasks', async () => {
        await d.click('#app-sidenav [data-app="actions"]', null, 1000);
        await d.cap('One sentence, one approval, and every date moved. Mondays stayed Mondays.', 3200);
    });
    await S('closing slide', async () => {
        await d.cap(null);
        await d.slide('A goal becomes a plan', 'One conversation. Dated tasks, a weekly review, and easy rescheduling.', 3600, CLOSING);
    });
}

/* ================= STORY: routines run for you ========================= */
if (story === 'routine') {
    // The task run must not fight ambient AI for the per-minute quota: the
    // injected mail would also fire triage + the thread judge, and that
    // contention is what marked good steps failed last take. Insights off
    // for this story — the trigger match itself is arithmetic.
    await d.E(`
        await EmailApp.loadData();
        EmailApp.aiInsightsEnabled = false;
        const blob = StorageManager.get('email') || {};
        blob.aiInsightsEnabled = false;
        StorageManager.set('email', blob);
        // Session-local stubs: the free tier allows 2 concurrent requests,
        // and a trickling triage/judge call holding a slot is what killed
        // planning twice. No fake outputs — ambient AI just sits this
        // recording out.
        EmailApp.analyzeSingleEmail = async () => true;
        EmailThreads._judgeFailures = 99;`);
    console.log('insights off; flushing any queued digest…');
    // A boot-time digest catch-up that failed transiently sits on the retry
    // backoff and blocks the queue; collapse the backoff and let it clear
    // so the triggered task doesn't wait behind it.
    await d.E(`RoutineEngine.retryNow?.(); RoutineEngine.tick?.();`);
    await d.waitFor(`((RoutineEngine.local || JSON.parse(localStorage.getItem('routine-state')||'{}')).queue || []).length === 0`, 300000, 'queue clear');
    console.log('queue clear; cooling the per-minute quota…');
    await sleep(65000);
    await S('title slide', () => d.slide('Some of your work just repeats',
        'An email arrives. You open it, read it, and do the same steps as last time. By hand, again.'));
    await S('home', () => home(1800));
    await S('open Routines', async () => {
        await d.click('#app-sidenav [data-app="prompts"]', null, 1000);
        await d.cap('These are the things Anjadhe does on its own. Some run on a schedule. Some run when a certain email arrives.', 3000);
    });
    await S('open the LinkedIn routine', async () => {
        await d.E(`
            const el = __demo.find('#prompts-view .routines-table tbody tr, #prompts-view .routines-table tr', 'LinkedIn');
            if (!el) throw new Error('no LinkedIn routine row');
            await __demo.clickEl(el);`);
        await d.cap('This one: when a LinkedIn job alert arrives, read it, read my real resume, and draft a tailored version. Armed once, with consent.', 3800);
    });
    await S('a job alert lands (real trigger)', async () => {
        await d.cap('Now a job alert lands.');
        await d.E(`
            const now = new Date();
            const body = ['Hi Emily,','','A new job matches your preferences.','','Staff Product Manager, Fleet Analytics','Lakeline Robotics - Austin, TX (hybrid)','','About the role:','Own the analytics product line for our warehouse-robotics fleet platform: dashboards, alerting, and the metrics API our 200+ customers run their operations on. Partner with data science and firmware to turn fleet telemetry into decisions.','','What we look for:','- 6+ years product management in B2B SaaS, analytics or robotics','- Shipped data or analytics products customers rely on daily','- Strong metrics-driven prioritization and experimentation habits','- Comfort working with embedded/hardware teams','- Crisp written communication for executive and customer audiences','','View job and apply on LinkedIn.','','LinkedIn Job Alerts'].join('\\n');
            const email = {
                messageId: 'demo-msg-linkedin-job2', threadId: 'demo-msg-linkedin-job2-thr',
                account: 'emily@demo.anjadhe.local',
                from: 'LinkedIn Job Alerts <jobalerts-noreply@linkedin.com>',
                to: 'Emily Carter <emily@demo.anjadhe.local>', cc: '',
                subject: 'New job for you: Staff Product Manager, Fleet Analytics at Lakeline Robotics',
                date: now.toUTCString(), messageIdHeader: '<demo-msg-linkedin-job2@demo.anjadhe.local>',
                snippet: 'Lakeline Robotics is hiring a Staff Product Manager, Fleet Analytics in Austin, TX (hybrid).',
                labels: ['INBOX', 'UNREAD', 'CATEGORY_UPDATES'], isRead: false, isStarred: false,
                internalDate: String(now.getTime()), attachments: [],
                bodyText: body,
                bodyHtml: body.split('\\n\\n').map(p => '<p>' + p.replace(/\\n/g, '<br>') + '</p>').join(''),
            };
            EmailApp.emails.unshift(email);
            await EmailApp._persistEmails([email]);
            RoutineEngine.onNewMail([email]);`);
        await sleep(4000);
    });
    await S('task starts', async () => {
        await d.waitFor(`typeof TaskService !== 'undefined' && TaskService._activeRuns.size > 0`, 60000, 'task start');
        await sleep(1200);
        // Refresh the detail so last-matched / queued lines paint.
        await d.E(`
            const el = __demo.find('#prompts-view .routines-table tbody tr, #prompts-view .routines-table tr', 'LinkedIn');
            if (el) await __demo.clickEl(el);`);
        await d.cap('The routine matched it. This run is about that one email, nothing else.', 2500);
    });
    await S('watch it work', async () => {
        await d.cap('Now it works. It opens the email, reads the resume file on disk, and writes. Nobody is driving.');
        const t0 = Date.now();
        while (Date.now() - t0 < 300000) {
            const st = await d.c.evaluate(`(() => ({
                running: typeof TaskService !== 'undefined' && TaskService._activeRuns.size > 0,
                waiting: !!document.querySelector('#prompts-waiting-section:not([hidden])'),
            }))()`);
            if (!st.running && !st.waiting) break;
            if (st.waiting) {
                await d.E(`
                    const b = __demo.find('#prompts-waiting button', null);
                    if (b) await __demo.clickEl(b);`);
                await sleep(2000);
            }
            await sleep(4000);
        }
        await sleep(1500);
    });
    await S('run history', async () => {
        await d.click('#app-sidenav [data-app="prompts"]', null, 800);
        await sleep(1000);
        await d.E(`
            const el = __demo.find('#prompts-view .routines-table tbody tr, #prompts-view .routines-table tr', 'LinkedIn');
            if (el) await __demo.clickEl(el);`);
        await sleep(1600);
        await d.cap('Every run leaves a log you can read later.');
        await d.E(`
            const h = __demo.find('#prompts-view h3, #prompts-view h4, #prompts-view div', 'Run history');
            h?.scrollIntoView({block:'center', behavior:'smooth'});`);
        await sleep(2200);
        await d.E(`
            const row = __demo.find('#prompts-view [data-run-id], #prompts-view .run-history-row, #prompts-view details, #prompts-view li', 'ago') ||
                        __demo.find('#prompts-view [data-run-id], #prompts-view .run-history-row, #prompts-view details', null);
            if (row) await __demo.clickEl(row);`);
        await d.cap(null, 2600);
    });
    await S('open the tailored resume note', async () => {
        await d.click('#app-sidenav [data-app="notes"]', null, 1000);
        await sleep(1400);
        await d.E(`
            const el = __demo.find('#notes-view [data-note-id], #notes-view .note-item, #notes-view li, #notes-view .note-row', 'Tailored resume');
            if (!el) throw new Error('no tailored resume note');
            await __demo.clickEl(el);`);
        await d.cap('And here is the deliverable. A tailored resume for that exact posting, built only from the real one.', 4200);
        await d.E(`
            const body = document.querySelector('#notes-view .note-editor, #notes-view [contenteditable], #notes-view .note-content');
            body?.scrollBy?.({top: 300, behavior: 'smooth'});`);
        await d.cap('It was ready before you even saw the alert.', 2600);
    });
    await S('closing slide', async () => {
        await d.cap(null);
        await d.slide('Routines work while you don’t', 'Armed once, with consent. Every run leaves a log.', 3600, CLOSING);
    });
}

/* ================= STORY: it remembers ================================= */
if (story === 'memory') {
    await S('title slide', () => d.slide('You shouldn’t have to repeat yourself',
        'The fact you mentioned last week is gone by the next chat. So you say it again, and again.'));
    await S('home', () => home(1800));
    await S('open the assistant', async () => {
        await d.click('#app-sidenav [data-app="agent"]', null, 1000);
        await d.cap('Tell it something worth keeping.', 1800);
    });
    await S('tell it something worth keeping', async () => {
        const nudges = [
            'Save this to your memory now: my knee is finicky — never increase my weekly running mileage by more than 10%. Actually save it with your memory tool, do not just acknowledge.',
            'You described it but did not save it — call your memory save tool with that fact now.',
            'Still not saved. Use the save_memory tool right now with that exact fact.',
        ];
        for (let i = 0; i < nudges.length; i++) {
            await d.askAndWait(nudges[i], 120000, i === 0 ? { zoom: 1.45 } : {});
            const ok = await d.c.evaluate(`(() => ((StorageManager.get('agent-memories')?.memories) || []).length > 0)()`);
            if (ok) break;
        }
        await sleep(2200);
    });
    await S('open the memory panel', async () => {
        await d.E(`
            const b = document.getElementById('agent-app-memory-btn');
            if (!b || !b.offsetParent) throw new Error('memory chip not visible');
            await __demo.clickEl(b);`);
        await d.cap('Saved, and visible. Every fact, with the exact words you said. Editable. Deletable. The memory is yours to read.', 4200);
    });
    await S('close memory panel', async () => {
        await d.E(`
            const close = __demo.find('dialog[open] .modal-close, .modal-close, dialog[open] button[aria-label="Close"]', null);
            if (close) await __demo.clickEl(close);
            else document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));`);
        await sleep(1200);
        // Belt and braces: close any open dialog.
        await d.E(`[...document.querySelectorAll('dialog[open]')].forEach(m => { try { m.close(); } catch (e) {} });`);
        await sleep(800);
    });
    await S('open the 10K goal', async () => {
        await d.cap('Decisions attach to one record. Here, a goal.');
        await d.click('#app-sidenav [data-app="goals"]', null, 1000);
        await sleep(1200);
        await d.openGoal('run a 10k');
    });
    await S('ask about this goal', async () => {
        await d.E(`
            const pill = __demo.find('#goals-view .ask-prompt-open, .ask-prompt-open', null)
                     || __demo.find('#goals-view button, #goals-view a', 'Ask about');
            if (pill) { await __demo.clickEl(pill); }
            else { AgentUI.openComposer(); }`);
        await sleep(1600);
    });
    await S('save a decision on it', async () => {
        await d.capOnAsk('Saving a standing instruction always asks first, and quotes exactly what will be kept.');
        const nudges = [
            'Save a decision on this goal: long runs are always on Saturday mornings, never on weekdays. Go ahead and save it now.',
            'You did not save it — call save_decision now with exactly that text.',
            'Still not saved. Use the save_decision tool right now.',
        ];
        for (const msg of nudges) {
            await d.askAndWait(msg, 150000);
            const ok = await d.c.evaluate(`(() => ((StorageManager.get('agent-decisions')?.decisions) || []).length > 0)()`);
            if (ok) break;
        }
        await sleep(2000);
    });
    await S('close panel, show the decision', async () => {
        await d.capOnAsk(null);
        await d.E(`
            const c = document.getElementById('agent-close-btn');
            if (c && c.offsetParent) await __demo.clickEl(c);`);
        await sleep(1000);
        await d.E(`
            const h = __demo.find('#goals-view h3, #goals-view h4, #goals-view div, #goals-view section', 'Decisions');
            h?.scrollIntoView({block:'center', behavior:'smooth'});`);
        await d.cap('From now on, anything that touches this goal sees that decision. You said it once.', 3800);
    });
    await S('closing slide', async () => {
        await d.cap(null);
        await d.slide('It remembers', 'Facts and decisions, kept where you can see them.', 3600, CLOSING);
    });
}

/* ================= STORY: it writes in your voice ====================== */
if (story === 'voice') {
    await S('title slide', () => d.slide('AI drafts never sound like you',
        'Wish they could? Give it documents you actually wrote. It can learn, and write new pieces in your voice.'));
    await S('open Writing Voices', async () => {
        await d.click('#app-sidenav [data-app="library"]', null, 1200);
        await d.cap('This is Writing Voices. Emily gave it three pieces she wrote herself: a work retro, a running post, a note to her team.', 3200);
    });
    await S('open the voice', async () => {
        await d.E(`
            const row = __demo.find('.library-voice-row', 'My voice');
            if (!row) throw new Error('no voice row');
            await __demo.clickEl(row);`);
        await sleep(1400);
        await d.cap('Anjadhe studied them. What it learned is a style guide you can read, and edit.');
        try { await d.zoomIn('.library-voice-body', null, { scale: 1.45, holdMs: 3800 }); }
        catch (e) { await d.E(`await __demo.holdLive(3200);`); }
    });
    await S('exemplars', async () => {
        await d.cap('And real passages from her documents, quoted verbatim, anchor it. Nothing hidden, nothing invented.');
        try { await d.zoomIn('.library-voice-ex', null, { scale: 1.45, holdMs: 3400 }); }
        catch (e) { await d.E(`await __demo.holdLive(2800);`); }
    });
    await S('draft in this voice', async () => {
        await d.cap(null);
        await d.E(`
            const pill = __demo.find('.library-voice-draft, [data-voice-draft]', null);
            if (!pill) throw new Error('no draft pill');
            await __demo.clickEl(pill);`);
        await sleep(1600);
        await d.cap('Now ask for something she never wrote.');
        await d.askAndWait('Write a short post for the neighborhood running group about training for a fall 10K through the Austin summer. Keep it under 250 words.', 180000, { zoom: 1.45 });
        await d.cap('A new piece, in her voice, grounded in her real writing, with its sources named at the end.', 4200);
    });
    await S('closing slide', async () => {
        await d.cap(null);
        await d.slide('It writes in your voice', 'Studied from your documents. Written down. Editable. Yours.', 3600, CLOSING);
    });
}

await d.stop();
d.c.close();
process.exit(0);
