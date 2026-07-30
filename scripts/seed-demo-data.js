#!/usr/bin/env node
/*
 * Seed a demo ANJADHE_DATA_ROOT with the fictional persona from docs/DEMO.md
 * (Priya Raman: product manager in Austin). Writes directly to the app's
 * stores; never touches real data. All dates are generated relative to
 * today, so the demo always looks current.
 *
 * better-sqlite3 in node_modules is compiled for Electron's ABI, so run
 * through Electron in node mode:
 *
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/seed-demo-data.js ~/AnjadheDemo
 *   ANJADHE_DATA_ROOT=~/AnjadheDemo npm start
 *
 * Refuses to run against an existing root unless --force is passed
 * (then it deletes and re-creates the root, a clean re-seed).
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');

const argRoot = process.argv[2];
if (!argRoot) {
    console.error('Usage: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/seed-demo-data.js <data-root> [--force]');
    process.exit(1);
}
const ROOT = path.resolve(argRoot.replace(/^~(?=$|\/)/, os.homedir()));
const FORCE = process.argv.includes('--force');
// Default: seed raw emails only and let the app generate insights live
// with the local model (requeueMissedAnalyses picks up unanalyzed mail
// newer than 3 days once a model is selected). --baked pre-seeds the
// analyses + derived tasks instead, for deterministic rehearsals.
const BAKED = process.argv.includes('--baked');

// Safety: never point this at the real userData.
const realUserData = path.join(os.homedir(), 'Library', 'Application Support', 'Anjadhe');
if (ROOT === realUserData || realUserData.startsWith(ROOT + path.sep)) {
    console.error('Refusing to seed into the real app data location: ' + ROOT);
    process.exit(1);
}
if (fs.existsSync(ROOT)) {
    if (!FORCE) {
        console.error(ROOT + ' already exists. Pass --force to delete and re-seed it.');
        process.exit(1);
    }
    fs.rmSync(ROOT, { recursive: true, force: true });
}

const USER_DATA = path.join(ROOT, 'userData');
fs.mkdirSync(USER_DATA, { recursive: true });

/* ---------- date helpers (all relative to today, local time) ---------- */

const now = new Date();
function at(dayOffset, hour = 9, minute = 0) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset, hour, minute, 0);
    return d;
}
function ymd(dayOffset) {
    const d = at(dayOffset);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function iso(dayOffset, hour = 9, minute = 0) {
    return at(dayOffset, hour, minute).toISOString();
}

let idCounter = 0;
function id(prefix) {
    idCounter += 1;
    return `demo-${prefix}-${idCounter.toString(36)}${Date.now().toString(36)}`;
}

/* ---------- settings (skip the setup wizard, keep sync off) ---------- */

const DEMO_EMAIL = 'priya@demo.anjadhe.local'; // reserved domain: EmailApp._isDemoAccount skips all Gmail sync for it

// Token-presence key so AccountsManager.hasLocalTokens keeps the demo
// account alive through syncToApps. electron-store splits keys on dots,
// so `googleTokens_priya@demo.anjadhe.local` must be written as a nested
// object to be readable via settingsStore.get('googleTokens_' + email).
fs.writeFileSync(
    path.join(USER_DATA, 'anjadhe-app-settings.json'),
    JSON.stringify({
        customStoragePath: null,
        setupComplete: true,
        machineId: 'Demo-Mac_local',
        syncEnabled: false,
        'googleTokens_priya@demo': { anjadhe: { local: 'demo-account-no-real-token' } },
    }, null, '\t')
);

/* ---------- persona data ---------- */

const stamp = { createdAt: iso(-30), modifiedAt: iso(-1) };

// Focus areas (palette colors from focus-ui.js)
const focus = {
    career: { id: id('focus'), title: 'Career', description: 'Product work at Fernwood Software', color: '#5C6BC0', group: 'Work', profile: 'default', parentId: null, resources: [], ...stamp },
    health: { id: id('focus'), title: 'Health & Fitness', description: 'Training for the fall 10K', color: '#7CB342', group: 'Life', profile: 'default', parentId: null, resources: [], ...stamp },
    family: { id: id('focus'), title: 'Family', description: '', color: '#EC407A', group: 'Life', profile: 'default', parentId: null, resources: [], ...stamp },
    finance: { id: id('focus'), title: 'Finance', description: '', color: '#26A69A', group: 'Life', profile: 'default', parentId: null, resources: [], ...stamp },
    learning: { id: id('focus'), title: 'Learning', description: 'Piano, a little every day', color: '#FF7043', group: 'Life', profile: 'default', parentId: null, resources: [], ...stamp },
};

const goals = {
    release: { id: id('goal'), title: 'Ship the fall release', description: 'Feature-complete by the end of next month, beta two weeks after.', targetDate: ymd(45), status: 'in-progress', profile: 'default', ...stamp },
    tenk: { id: id('goal'), title: 'Run a 10K in under an hour', description: 'Race day is on the calendar. Three runs a week.', targetDate: ymd(60), status: 'in-progress', profile: 'default', ...stamp },
    trip: { id: id('goal'), title: 'Plan the December family trip', description: 'Ten days, somewhere warm. Flights, hotel, and one big surprise for Arjun.', targetDate: ymd(130), status: 'in-progress', profile: 'default', ...stamp },
    rebalance: { id: id('goal'), title: 'Rebalance retirement accounts', description: 'Old 401(k) still sitting in a money-market fund. Move it.', targetDate: ymd(21), status: 'need-help', profile: 'default', ...stamp },
    piano: { id: id('goal'), title: 'Play three songs on piano from memory', description: 'Twenty minutes a day, working through the beginner course. Weekly lesson with Ms. Elena.', targetDate: ymd(90), status: 'in-progress', profile: 'default', ...stamp },
};

function task(t) {
    return {
        id: id('task'),
        title: t.title,
        description: t.description || '',
        startTime: t.startTime || '',
        endTime: null,
        notifyBefore: 0,
        repeat: t.repeat || 'none',
        dayOfWeek: null,
        repeatDays: [],
        scheduledDate: t.date,
        reminderDaysBefore: [0],
        lastCompletedDate: t.done || null,
        history: t.history || {},
        profile: 'default',
        createdAt: t.createdAt || iso(-7),
        modifiedAt: t.modifiedAt || iso(-1),
        _goal: t.goal || null, // stripped below; used to build links
    };
}

const tasks = [
    // Overdue
    task({ title: 'Send updated roadmap deck to leadership', date: ymd(-2), goal: 'release', description: 'Waiting on the Q3 numbers from Dana.' }),
    task({ title: 'Book flights for the December trip', date: ymd(-1), goal: 'trip' }),
    // Today
    task({ title: 'Review sprint burndown before standup', date: ymd(0), startTime: '09:00', goal: 'release' }),
    task({ title: '5K training run', date: ymd(0), startTime: '07:00', goal: 'tenk' }),
    task({ title: 'Piano practice: 20 minutes of scales', date: ymd(0), goal: 'piano' }),
    task({ title: 'Pay the credit card bill', date: ymd(0) }),
    // This week
    task({ title: '1:1 with Sam: growth plan', date: ymd(1), startTime: '14:00', goal: 'release' }),
    task({ title: 'Compare hotels in Puerto Vallarta', date: ymd(2), goal: 'trip' }),
    task({ title: 'Long run: 8K', date: ymd(3), startTime: '07:30', goal: 'tenk' }),
    task({ title: 'Move the old 401(k) into the target-date fund', date: ymd(5), goal: 'rebalance', description: 'Rollover form is in the Finance note.' }),
    task({ title: 'Draft release notes', date: ymd(6), goal: 'release' }),
    task({ title: 'Piano lesson with Ms. Elena', date: ymd(4), startTime: '17:30', goal: 'piano' }),
    // Later
    task({ title: 'Order school picture day photos', date: ymd(12) }),
    task({ title: 'Quarterly portfolio review', date: ymd(20), goal: 'rebalance' }),
    // Done
    task({ title: 'Book dentist appointment', date: ymd(-3), done: ymd(-3), history: { [ymd(-3)]: 'done' } }),
    task({ title: 'Interval training at the track', date: ymd(-2), done: ymd(-2), goal: 'tenk', history: { [ymd(-2)]: 'done' } }),
    // Recurring
    task({ title: 'Team standup', date: ymd(-30), startTime: '09:30', repeat: 'weekdays', goal: 'release' }),
];

// Cross-app links: focus -> goal, goal -> task
const links = [];
const goalFocus = { release: 'career', tenk: 'health', trip: 'family', rebalance: 'finance', piano: 'learning' };
for (const [gKey, fKey] of Object.entries(goalFocus)) {
    links.push({ id: id('link'), sourceApp: 'focus', sourceId: focus[fKey].id, targetApp: 'goals', targetId: goals[gKey].id, createdAt: iso(-30) });
}
for (const t of tasks) {
    if (t._goal) {
        links.push({ id: id('link'), sourceApp: 'goals', sourceId: goals[t._goal].id, targetApp: 'schedule', targetId: t.id, createdAt: t.createdAt });
    }
    delete t._goal;
}

const tags = ['work', 'personal', 'ideas', 'travel', 'recipes'].map((name) => ({ id: 'tag_' + name, name, profile: 'default' }));

const notes = [
    {
        id: id('note'), title: 'Sprint 14 retro notes', template: 'blank', tags: ['work'], pinned: false, showOnHome: false, profile: 'default',
        content: '<p><strong>Went well:</strong> search latency work landed a week early.</p><p><strong>Didn’t:</strong> two carry-overs again, both blocked on design review.</p><p><strong>Try:</strong> design review moves to Tuesday so the sprint doesn’t end on a bottleneck.</p>',
        createdAt: iso(-4, 16), modifiedAt: iso(-4, 16),
    },
    {
        id: id('note'), title: '1:1 agenda: Sam', template: 'blank', tags: ['work'], pinned: false, showOnHome: false, profile: 'default',
        content: '<p>1. Growth plan: wants to lead the mobile track next quarter</p><p>2. Feedback on the roadmap deck</p><p>3. Conference budget</p>',
        createdAt: iso(-2, 11), modifiedAt: iso(-1, 9),
    },
    {
        id: id('note'), title: 'December trip ideas', template: 'blank', tags: ['personal', 'travel'], pinned: false, showOnHome: false, profile: 'default',
        content: '<p>Puerto Vallarta vs. San Diego. PV wins on price if flights stay under $450.</p><p>Must-do: whale watching (Arjun has been asking for a year), one lazy beach day, old town food walk.</p><p>Hotel shortlist in Bookmarks.</p>',
        createdAt: iso(-9, 20), modifiedAt: iso(-2, 21),
    },
    {
        id: id('note'), title: 'Saturday waffles', template: 'blank', tags: ['recipes'], pinned: false, showOnHome: false, profile: 'default',
        content: '<p>2 cups flour, 1 tbsp baking powder, 2 tbsp sugar, pinch of salt.</p><p>2 eggs (whites whipped separately and folded in last), 1¾ cups buttermilk, ½ cup melted butter, splash of vanilla.</p><p>Rest the batter 10 minutes. Waffle iron on medium-high; do not open early. Arjun likes his with peanut butter and banana.</p>',
        createdAt: iso(-40, 18), modifiedAt: iso(-40, 18),
    },
    {
        id: id('note'), title: 'Feature idea: quiet mode', template: 'blank', tags: ['ideas'], pinned: true, showOnHome: false, profile: 'default',
        content: '<p>One switch that pauses every non-critical notification until tomorrow morning. Not per-app settings, one honest switch.</p><p>Pitch it at the fall planning offsite.</p>',
        createdAt: iso(-13, 22), modifiedAt: iso(-13, 22),
    },
];

const moods = ['happy', 'neutral', 'amazing', 'stressed', 'happy', 'neutral', 'sad', 'happy', 'neutral'];
const journalTexts = [
    'Morning run felt easy for the first time. Maybe the plan is working.',
    'Long day of roadmap reviews. Note to self: fewer slides, more decisions.',
    'Arjun lost his first tooth and negotiated the tooth fairy up to five dollars. Proud and slightly concerned.',
    'Release scope grew again. Pushed back, mostly held the line. Tired.',
    'Waffle Saturday. Whipping the egg whites separately really is worth it.',
    'Skipped the run, knee felt off. Resting it two days, not going to be a hero.',
    'Rainy Saturday. Everyone home, board games, nothing productive. Perfect.',
    'Twenty minutes of piano after dinner. The left hand is finally catching up to the right.',
    'Quiet evening. Planned the week, feels handled for once.',
];
const journalOffsets = [-14, -13, -11, -9, -8, -6, -4, -2, -1];
const journalEntries = journalOffsets.map((off, i) => ({
    id: id('journal'),
    content: '<p>' + journalTexts[i] + '</p>',
    mood: moods[i],
    tags: [],
    profile: 'default',
    date: iso(off, 21, 15),
    createdAt: iso(off, 21, 15),
    modifiedAt: iso(off, 21, 15),
}));

const bookmarkGroups = ['Work', 'Running', 'Travel', 'Cooking', 'Learning'];
const bookmarks = [
    { title: 'Hal Higdon 10K training plans', url: 'https://www.halhigdon.com/training/10k-training/', group: 'Running', tags: ['personal'] },
    { title: 'Puerto Vallarta travel guide', url: 'https://www.lonelyplanet.com/mexico/puerto-vallarta', group: 'Travel', tags: ['travel'] },
    { title: 'Sprint metrics dashboard', url: 'https://linear.app', group: 'Work', tags: ['work'] },
    { title: 'Serious Eats: light and crisp waffles', url: 'https://www.seriouseats.com/light-and-crisp-waffles-recipe', group: 'Cooking', tags: ['recipes'] },
    { title: 'Pianote beginner lessons', url: 'https://www.pianote.com/', group: 'Learning', tags: ['personal'] },
    { title: 'Continuous discovery habits notes', url: 'https://www.producttalk.org/', group: 'Work', tags: ['work', 'ideas'] },
].map((b) => ({ id: id('bm'), description: '', notes: '', profile: 'default', createdAt: iso(-20), modifiedAt: iso(-20), ...b }));

/* ---------- mock inbox (rendered from the local cache, never synced) ---------- */

// Email fixtures. `off`/`hh` place the message in time (relative days);
// unread mail carries both isRead:false and the UNREAD label so the JSON
// and the denormalized columns agree. By default only the raw messages
// are seeded and the app does its own bundling live (category-label
// rules first, then the local-LLM pass for the rest); --baked seeds the
// `bundle` verdicts too so the inbox is tidy with no model involved.
function email(m) {
    const d = at(m.off, m.hh || 9, m.min || 0);
    const labels = ['INBOX'];
    if (!m.read) labels.push('UNREAD');
    if (m.important) labels.push('IMPORTANT');
    if (m.category) labels.push(m.category);
    return {
        messageId: m.id,
        threadId: m.id + '-thr',
        account: DEMO_EMAIL,
        from: m.from,
        to: `Priya Raman <${DEMO_EMAIL}>`,
        cc: '',
        subject: m.subject,
        date: d.toUTCString(),
        messageIdHeader: `<${m.id}@demo.anjadhe.local>`,
        snippet: m.snippet,
        labels,
        isRead: !!m.read,
        isStarred: false,
        internalDate: String(d.getTime()),
        attachments: [],
        ...(BAKED ? { bundle: m.bundle || 'none', bundleBy: 'user' } : {}),
        _bodyText: m.body,
        _bodyHtml: m.body.split('\n\n').map((p) => '<p>' + p.replace(/\n/g, '<br>') + '</p>').join(''),
    };
}

const mockEmails = [
    email({
        id: 'demo-msg-roadmap', off: -1, hh: 9, min: 14, read: false, important: true, category: 'CATEGORY_PERSONAL',
        from: 'Dana Whitfield <dana@fernwoodsoftware.com>',
        subject: 'Roadmap deck for Thursday leadership review',
        snippet: 'Can you send the final version of the roadmap deck before the leadership review on Thursday?',
        body: 'Hi Priya,\n\nCan you send the final version of the roadmap deck before the leadership review on Thursday? I want a day to add the budget slide, so end of Wednesday would be perfect.\n\nAlso, nice work on the search latency numbers. They are going straight into the exec summary.\n\nDana',
    }),
    email({
        id: 'demo-msg-oneonone', off: 0, hh: 8, min: 5, read: false, important: true, category: 'CATEGORY_PERSONAL',
        from: 'Sam Torres <sam.torres@fernwoodsoftware.com>',
        subject: 'Can we move our 1:1 to Thursday?',
        snippet: 'Something came up tomorrow afternoon. Could we move our 1:1 to Thursday same time?',
        body: 'Hey Priya,\n\nSomething came up tomorrow afternoon. Could we move our 1:1 to Thursday, same time? I still want to walk through the growth plan, and I have an idea about the mobile track I want to pitch you.\n\nSam',
    }),
    email({
        id: 'demo-msg-renewal', off: -1, hh: 7, min: 30, read: false, important: true,
        from: 'TrueShield Insurance <renewals@trueshieldinsurance.com>',
        subject: `Your auto policy renews on ${ymd(10)}`,
        snippet: 'Your TrueShield auto policy is set to renew. Your new six-month premium is $612.50.',
        body: `Dear Priya Raman,\n\nYour TrueShield auto policy #TX-48211 is set to renew on ${ymd(10)}. Your new six-month premium is $612.50, an increase of $38 from your current term.\n\nIf you would like to review coverage options or update your vehicles before renewal, visit your account or call us.\n\nTrueShield Insurance`,
    }),
    email({
        id: 'demo-msg-dentist', off: -2, hh: 11, read: true, important: true,
        from: 'Bright Smile Dental <appointments@brightsmiledental.com>',
        subject: `Appointment confirmed: ${ymd(4)} at 2:00 PM`,
        snippet: 'This confirms your cleaning appointment with Dr. Nguyen.',
        body: `Hi Priya,\n\nThis confirms your cleaning appointment with Dr. Nguyen on ${ymd(4)} at 2:00 PM.\n\nPlease arrive 10 minutes early. Reply RESCHEDULE if you need a different time.\n\nBright Smile Dental, Austin`,
    }),
    email({
        id: 'demo-msg-streamnest', off: -1, hh: 6, read: true, category: 'CATEGORY_UPDATES', bundle: 'updates',
        from: 'StreamNest <billing@streamnest.tv>',
        subject: 'Your StreamNest receipt: $15.99',
        snippet: 'Thanks for being a StreamNest member. Your monthly plan renewed at $15.99.',
        body: 'Hi Priya,\n\nThanks for being a StreamNest member. Your Premium plan renewed on your card ending 4482.\n\nAmount charged: $15.99\nNext billing date: one month from today\n\nStreamNest Billing',
    }),
    email({
        id: 'demo-msg-utility', off: -2, hh: 8, read: true, category: 'CATEGORY_UPDATES', bundle: 'updates',
        from: 'Austin Utilities <billing@austinutilities.com>',
        subject: `Your July statement is ready: $184.32 due ${ymd(6)}`,
        snippet: 'Your monthly statement is now available. Amount due: $184.32.',
        body: `Dear customer,\n\nYour monthly statement for account 7734-A is now available.\n\nAmount due: $184.32\nDue date: ${ymd(6)}\n\nEnroll in autopay to never miss a due date.\n\nAustin Utilities`,
    }),
    email({
        id: 'demo-msg-flight', off: -2, hh: 15, read: true, category: 'CATEGORY_UPDATES', bundle: 'travel',
        from: 'Aerolane Airlines <confirmations@aerolane.com>',
        subject: 'Booking confirmed: AUS to PVR, Dec 12 - Dec 22',
        snippet: 'Confirmation code AER8Q2. Austin (AUS) to Puerto Vallarta (PVR), 3 travelers.',
        body: 'Your booking is confirmed.\n\nConfirmation code: AER8Q2\nOutbound: Dec 12, AUS 10:40 AM to PVR 1:05 PM\nReturn: Dec 22, PVR 2:20 PM to AUS 6:45 PM\nTravelers: 3\n\nManage your booking online with your confirmation code.\n\nAerolane Airlines',
    }),
    email({
        id: 'demo-msg-school', off: -2, hh: 17, read: true, category: 'CATEGORY_UPDATES', bundle: 'updates',
        from: 'Maple Grove Elementary <news@maplegroveelementary.org>',
        subject: 'Fall newsletter: picture day and field trip forms',
        snippet: 'Picture day is coming up, and field trip permission slips are due next Friday.',
        body: 'Dear families,\n\nWelcome back! A few dates for your calendar:\n\nPicture day is coming up in two weeks. Order forms went home in backpacks this week.\n\nField trip permission slips for the science museum are due next Friday.\n\nMaple Grove Elementary',
    }),
    email({
        id: 'demo-msg-promo1', off: -1, hh: 12, read: true, category: 'CATEGORY_PROMOTIONS', bundle: 'promos',
        from: 'Verde Threads <hello@verdethreads.com>',
        subject: 'Mid-summer sale: 30% off everything',
        snippet: 'Our biggest sale of the season is here. 30% off sitewide through Sunday.',
        body: 'Our biggest sale of the season is here.\n\n30% off sitewide through Sunday, no code needed.\n\nVerde Threads',
    }),
    email({
        id: 'demo-msg-promo2', off: -2, hh: 13, read: false, category: 'CATEGORY_PROMOTIONS', bundle: 'promos',
        from: 'TrailPeak Outfitters <deals@trailpeak.com>',
        subject: 'Weekend flash sale on trail runners',
        snippet: 'Up to 40% off select trail running shoes this weekend only.',
        body: 'This weekend only:\n\nUp to 40% off select trail running shoes, plus free returns.\n\nTrailPeak Outfitters',
    }),
    email({
        id: 'demo-msg-promo3', off: -2, hh: 10, read: true, category: 'CATEGORY_PROMOTIONS', bundle: 'promos',
        from: 'BookNook <newsletter@booknook.com>',
        subject: 'New releases we think you will love',
        snippet: 'Ten new releases picked for you, plus a member coupon inside.',
        body: 'Ten new releases picked for you this month, plus a member coupon inside.\n\nHappy reading,\nBookNook',
    }),
];

// Pre-baked insights, used only with --baked. The default is to seed no
// analyses at all: every message is dated within the app's 3-day
// analysis-recovery window, so once a local model is selected the app
// queues the real pipeline and insights generate live. readAt null = the
// insight still shows as unread (badges, feed).
function analysis(a) {
    return {
        relevant: true,
        actionRequired: !!a.action,
        suppress: false,
        type: a.type,
        actionItems: a.action ? [{ text: a.action, dueDate: a.dueDate, dueTime: a.dueTime || null, reminderStrategy: 'single', reminderDaysBefore: [1] }] : [],
        insights: a.insights,
        eventDate: a.dueDate || null,
        amount: a.amount || null,
        priority: a.priority,
        summary: a.summary,
        analyzedAt: a.analyzedAt,
        readAt: a.readAt || null,
    };
}

const bakedAnalyses = {
    'demo-msg-roadmap': analysis({
        type: 'deadline', priority: 'high', analyzedAt: iso(-1, 11),
        action: 'Share the final roadmap deck with the leadership team', dueDate: ymd(3), dueTime: '17:00',
        insights: ['Leadership review is Thursday', 'Dana wants a day to add the budget slide, so Wednesday evening is the real deadline'],
        summary: 'Dana needs the final roadmap deck by end of Wednesday for the Thursday leadership review.',
    }),
    'demo-msg-renewal': analysis({
        type: 'renewal', priority: 'high', analyzedAt: iso(-1, 9), amount: '$612.50',
        action: 'Renew or review auto insurance policy', dueDate: ymd(8),
        insights: ['Premium went up $38 from the current term', 'Reviewing coverage before the renewal date could lower it'],
        summary: `TrueShield auto policy renews ${ymd(10)} at $612.50, up $38 from last term.`,
    }),
    'demo-msg-dentist': analysis({
        type: 'appointment', priority: 'medium', analyzedAt: iso(-2, 12), readAt: iso(-1, 8),
        action: 'Dentist appointment with Dr. Nguyen', dueDate: ymd(4), dueTime: '14:00',
        insights: ['Arrive 10 minutes early'],
        summary: `Cleaning appointment with Dr. Nguyen confirmed for ${ymd(4)} at 2:00 PM.`,
    }),
    'demo-msg-streamnest': analysis({
        type: 'payment', priority: 'medium', analyzedAt: iso(-1, 8), amount: '$15.99',
        insights: ['This subscription has renewed monthly all year', 'Cancel or downgrade anytime from the StreamNest account page'],
        summary: 'StreamNest charged $15.99 for another month, a recurring subscription worth a look.',
    }),
    'demo-msg-utility': analysis({
        type: 'payment', priority: 'medium', analyzedAt: iso(-2, 9), readAt: iso(-1, 8), amount: '$184.32',
        action: 'Pay Austin Utilities bill', dueDate: ymd(6),
        insights: ['Autopay enrollment is available'],
        summary: `Austin Utilities statement of $184.32 is due ${ymd(6)}.`,
    }),
    'demo-msg-flight': analysis({
        type: 'general', priority: 'low', analyzedAt: iso(-2, 16), readAt: iso(-1, 8),
        insights: ['Confirmation code AER8Q2', 'Three travelers, Dec 12 to Dec 22'],
        summary: 'December trip flights are booked: Austin to Puerto Vallarta, Dec 12 to Dec 22.',
    }),
};

// Email-derived tasks + the dedup ledger, exactly as
// EmailApp.syncActionItemsToSchedule would create them. Without the
// ledger entries, backfillScheduleSync would duplicate these on every
// launch.
function normalizeActionText(text) {
    return String(text).toLowerCase().replace(/\s+/g, ' ').trim().replace(/[.!?,;:]+$/, '');
}
const priorityAnalyses = BAKED ? bakedAnalyses : {};
const emailActionLedger = {};
for (const [msgId, a] of Object.entries(priorityAnalyses)) {
    if (!a.actionRequired || !a.actionItems.length) continue;
    const src = mockEmails.find((m) => m.messageId === msgId);
    for (const item of a.actionItems) {
        const t = task({ title: item.text, date: item.dueDate, startTime: item.dueTime || '07:00', createdAt: a.analyzedAt, modifiedAt: a.analyzedAt });
        t.source = 'email';
        t.sourceEmailId = msgId;
        t.sourceEmailSubject = src.subject;
        t.sourceEmailFrom = src.from;
        t.reminderStrategy = item.reminderStrategy;
        t.reminderDaysBefore = item.reminderDaysBefore;
        delete t._goal;
        tasks.push(t);
        emailActionLedger[`${msgId}::${normalizeActionText(item.text)}`] = t.id;
    }
}

/* ---------- portfolio ---------- */

const acct = {
    brokerage: { id: id('acct'), name: 'Fidelity Brokerage', type: 'brokerage', profile: 'default', cashBalance: 4200, createdAt: iso(-900) },
    k401: { id: id('acct'), name: 'Employer 401(k)', type: '401k', profile: 'default', cashBalance: 0, createdAt: iso(-900) },
    hsa: { id: id('acct'), name: 'HSA', type: 'hsa', profile: 'default', cashBalance: 850, createdAt: iso(-700) },
    savings: { id: id('acct'), name: 'Ally Savings', type: 'savings', profile: 'default', cashBalance: 12500, createdAt: iso(-900) },
};

function txn(accountKey, type, ticker, quantity, pricePerShare, dayOffset) {
    return { id: id('txn'), accountId: acct[accountKey].id, type, ticker, quantity, pricePerShare, date: ymd(dayOffset), notes: '', createdAt: iso(dayOffset) };
}

const transactions = [
    txn('brokerage', 'holding', 'AAPL', 30, 150, -820),
    txn('brokerage', 'buy', 'AAPL', 10, 178, -420),
    txn('brokerage', 'buy', 'AAPL', 5, 186, -200),
    txn('brokerage', 'holding', 'MSFT', 15, 280, -820),
    txn('brokerage', 'buy', 'MSFT', 5, 402, -300),
    txn('brokerage', 'buy', 'VTI', 40, 220, -700),
    txn('brokerage', 'buy', 'VTI', 20, 252, -360),
    txn('brokerage', 'buy', 'VTI', 15, 270, -120),
    txn('k401', 'holding', 'VFIFX', 400, 38, -820),
    txn('k401', 'buy', 'VFIFX', 60, 44, -400),
    txn('k401', 'buy', 'VFIFX', 60, 47, -150),
    txn('hsa', 'buy', 'VTI', 10, 240, -500),
];

const properties = [
    { id: id('prop'), name: 'Rental condo, Round Rock', address: '2310 Juniper Ln, Round Rock, TX', currentValue: 385000, purchasePrice: 290000, purchaseDate: '2019-06-14', notes: 'Leased through May.', profile: 'default', createdAt: iso(-900) },
];

// Value history: a plausible walk over the last ~6 months, from actual
// share counts at each snapshot times linearly drifting prices. Live
// prices take over at the endpoint once the app fetches quotes.
const priceDrift = { AAPL: [205, 236], MSFT: [430, 505], VTI: [268, 302], VFIFX: [46, 52] };
const HISTORY_DAYS = 180;
function sharesAsOf(tickerWanted, dayOffset) {
    let total = 0;
    for (const t of transactions) {
        if (t.ticker !== tickerWanted) continue;
        if (t.date > ymd(dayOffset)) continue;
        total += (t.type === 'sell' ? -1 : 1) * t.quantity;
    }
    return total;
}
const totalCash = Object.values(acct).reduce((s, a) => s + (a.cashBalance || 0), 0);
const realEstateValue = properties.reduce((s, p) => s + p.currentValue, 0);
const valueHistory = [];
for (let off = -HISTORY_DAYS; off <= -1; off += 3) {
    const f = (off + HISTORY_DAYS) / HISTORY_DAYS; // 0 -> 1
    const tickers = {};
    let stockValue = 0;
    for (const [tk, [p0, p1]] of Object.entries(priceDrift)) {
        const shares = sharesAsOf(tk, off);
        if (shares <= 0) continue;
        const wobble = Math.sin(off * 1.7) * 0.012 + Math.sin(off * 0.31) * 0.02;
        const price = +((p0 + (p1 - p0) * f) * (1 + wobble)).toFixed(2);
        const value = +(price * shares).toFixed(2);
        tickers[tk] = { price, value, shares };
        stockValue += value;
    }
    stockValue = +stockValue.toFixed(2);
    const perAccount = {};
    for (const a of Object.values(acct)) {
        let v = a.cashBalance || 0;
        for (const t of transactions) {
            if (t.accountId !== a.id || t.date > ymd(off)) continue;
            const tk = tickers[t.ticker];
            if (tk) v += (t.type === 'sell' ? -1 : 1) * t.quantity * tk.price;
        }
        perAccount[a.id] = { value: +v.toFixed(2), cash: a.cashBalance || 0 };
    }
    valueHistory.push({
        date: ymd(off),
        totalValue: +(stockValue + totalCash + realEstateValue).toFixed(2),
        stockValue,
        cash: totalCash,
        realEstateValue,
        tickers,
        accounts: perAccount,
    });
}

/* ---------- write everything ---------- */

const db = new Database(path.join(USER_DATA, 'anjadhe-app-data.db'));
db.pragma('journal_mode = WAL');
db.exec('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT)');
db.exec(`CREATE TABLE IF NOT EXISTS emails (
    messageId TEXT PRIMARY KEY,
    account TEXT NOT NULL,
    internalDate INTEGER DEFAULT 0,
    isRead INTEGER DEFAULT 0,
    isStarred INTEGER DEFAULT 0,
    labels TEXT DEFAULT '[]',
    data TEXT NOT NULL
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_emails_account_date ON emails(account, internalDate DESC)');
db.exec('CREATE INDEX IF NOT EXISTS idx_emails_date ON emails(internalDate DESC)');
db.exec('CREATE TABLE IF NOT EXISTS email_bodies (messageId TEXT PRIMARY KEY, bodyText TEXT, bodyHtml TEXT)');

const put = db.prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)');
const set = (k, v) => put.run('app_' + k, JSON.stringify(v));
const putEmail = db.prepare('INSERT OR REPLACE INTO emails (messageId, account, internalDate, isRead, isStarred, labels, data) VALUES (?, ?, ?, ?, ?, ?, ?)');
const putBody = db.prepare('INSERT OR REPLACE INTO email_bodies (messageId, bodyText, bodyHtml) VALUES (?, ?, ?)');

db.transaction(() => {
    set('profiles', { profiles: [{ id: 'default', name: 'Default', createdAt: iso(-900), modifiedAt: iso(-900) }] });
    set('focus', { focusItems: Object.values(focus) });
    set('goals', { goals: Object.values(goals) });
    set('schedule', { scheduleItems: tasks, emailActionLedger });
    set('links', { links });
    set('tags', { tags });
    set('notes', { notes });
    set('journal', { entries: journalEntries });
    set('bookmarks', { bookmarks, groups: bookmarkGroups.map((name) => ({ name, createdAt: iso(-20) })) });
    set('portfolio', { accounts: Object.values(acct), transactions, properties, priceCache: {}, valueHistory });
    set('promptFeed', { items: [], runs: {} });
    set('actionsSettings', { aiFiling: true });

    // Mock inbox: unified account registry, EmailApp state, priority
    // senders, and the cached messages themselves.
    set('accounts', {
        migratedFromLegacy: true,
        accounts: [{
            id: 'acc_demo1', provider: 'google', email: DEMO_EMAIL, displayName: 'Priya Raman',
            services: { mail: true, calendar: false }, connectedAt: iso(-50), lastSyncAt: null,
        }],
    });
    set('email', {
        accounts: [{ id: 'acc_demo1_email', email: DEMO_EMAIL, provider: 'gmail', profile: 'default', connectedAt: iso(-50) }],
        labels: ['INBOX', 'SENT', 'DRAFTS', 'STARRED', 'IMPORTANT', 'TRASH'],
        lastSyncTime: iso(0, 7),
        lastHistoryIds: { [DEMO_EMAIL]: '99999' },
        nextPageTokens: {},
        backfillDone: { [DEMO_EMAIL]: true },
        priorityAnalyses,
        analyzedNoInsight: {},
        pendingAnalysisIds: [],
        priorityAutoAnalyze: true,
        aiInsightsEnabled: true,
        showUnreadOnly: false,
        showInsightsUnreadOnly: true,
        bundleRulesVer: 2,
        contacts: [],
    });
    set('emailPriorityTerms', {
        terms: [
            { term: '@fernwoodsoftware.com', category: 'work' },
            { term: 'renewals@trueshieldinsurance.com', category: 'general' },
            { term: 'appointments@brightsmiledental.com', category: 'health' },
        ],
    });
    set('emailInsightSettings', {
        autoDetect: true,
        enabledTypes: { renewal: true, payment: true, appointment: true, delivery: true, security: true, deadline: true, general: true },
        mutedSenders: [], insightFeedback: {}, dismissedExamples: {},
    });
    set('emailBundleConfig', { custom: [], hidden: [], senderRules: {} });

    for (const m of mockEmails) {
        const { _bodyText, _bodyHtml, ...data } = m;
        putEmail.run(m.messageId, m.account, Number(m.internalDate), m.isRead ? 1 : 0, 0, JSON.stringify(m.labels), JSON.stringify(data));
        putBody.run(m.messageId, _bodyText, _bodyHtml);
    }
})();
db.close();

console.log('Seeded demo data root: ' + ROOT);
console.log('  ' + tasks.length + ' tasks, ' + Object.keys(goals).length + ' goals, ' + Object.keys(focus).length + ' focus areas, ' + notes.length + ' notes, ' + journalEntries.length + ' journal entries, ' + bookmarks.length + ' bookmarks');
console.log('  Portfolio: ' + Object.keys(acct).length + ' accounts, ' + transactions.length + ' transactions, ' + valueHistory.length + ' value snapshots');
if (BAKED) {
    console.log('  Mock inbox: ' + mockEmails.length + ' emails for ' + DEMO_EMAIL + ', ' + Object.keys(priorityAnalyses).length + ' pre-baked insights, ' + Object.keys(emailActionLedger).length + ' email-derived tasks (--baked)');
} else {
    console.log('  Mock inbox: ' + mockEmails.length + ' raw emails for ' + DEMO_EMAIL + '. No insights, no bundles seeded.');
    console.log('  Bundling and insights happen live: select a local model in the demo instance (Settings > AI Assistant), then open Email.');
    console.log('  For deterministic rehearsals, re-seed with --baked to pre-bake insights and bundles instead.');
}
console.log('Launch with: ANJADHE_DATA_ROOT=' + ROOT + ' npm start');
