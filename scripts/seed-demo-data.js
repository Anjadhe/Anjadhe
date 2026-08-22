#!/usr/bin/env node
/*
 * Seed a demo ANJADHE_DATA_ROOT with the fictional persona from docs/DEMO.md
 * (Emily Carter: product manager in Austin). Writes directly to the app's
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
// --legacy writes the pre-2026-07-31 shape (focus-area records, goal→focus
// links, group-less goals) for testing GoalsApp.migrateFromFocus.
const LEGACY = process.argv.includes('--legacy');

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

const DEMO_EMAIL = 'emily@demo.anjadhe.local'; // reserved domain: EmailApp._isDemoAccount skips all Gmail sync for it

// Token-presence key so AccountsManager.hasLocalTokens keeps the demo
// account alive through syncToApps. electron-store splits keys on dots,
// so `googleTokens_emily@demo.anjadhe.local` must be written as a nested
// object to be readable via settingsStore.get('googleTokens_' + email).
fs.writeFileSync(
    path.join(USER_DATA, 'anjadhe-app-settings.json'),
    JSON.stringify({
        customStoragePath: null,
        setupComplete: true,
        machineId: 'Demo-Mac_local',
        syncEnabled: false,
        'googleTokens_emily@demo': { anjadhe: { local: 'demo-account-no-real-token' } },
    }, null, '\t')
);

/* ---------- persona data ---------- */

const stamp = { createdAt: iso(-30), modifiedAt: iso(-1) };

// Legacy focus areas — written only under --legacy (goals carry `group`
// directly since 2026-07-31; migrateFromFocus derives it from these).
const focus = {
    career: { id: id('focus'), title: 'Career', description: 'Product work at Fernwood Software', color: '#5C6BC0', group: 'Work', profile: 'default', parentId: null, resources: [], ...stamp },
    health: { id: id('focus'), title: 'Health & Fitness', description: 'Training for the fall 10K', color: '#7CB342', group: 'Life', profile: 'default', parentId: null, resources: [], ...stamp },
    family: { id: id('focus'), title: 'Family', description: '', color: '#EC407A', group: 'Life', profile: 'default', parentId: null, resources: [], ...stamp },
    finance: { id: id('focus'), title: 'Finance', description: '', color: '#26A69A', group: 'Life', profile: 'default', parentId: null, resources: [], ...stamp },
    learning: { id: id('focus'), title: 'Learning', description: 'Piano, a little every day', color: '#FF7043', group: 'Life', profile: 'default', parentId: null, resources: [], ...stamp },
};

// Goal groups mirror the old focus-area titles (that is exactly what the
// migration derives). --legacy omits the field so the migration can run.
const goals = {
    release: { id: id('goal'), title: 'Ship the fall release', description: 'Feature-complete by the end of next month, beta two weeks after.', group: 'Career', targetDate: ymd(45), status: 'not-started', profile: 'default', ...stamp },
    tenk: { id: id('goal'), title: 'Run a 10K in under an hour', description: 'Race day is on the calendar. Three runs a week.', group: 'Health & Fitness', targetDate: ymd(60), status: 'not-started', profile: 'default', ...stamp },
    trip: { id: id('goal'), title: 'Plan the December family trip', description: 'Ten days, somewhere warm. Flights, hotel, and one big surprise for Owen.', group: 'Family', targetDate: ymd(130), status: 'not-started', profile: 'default', ...stamp },
    rebalance: { id: id('goal'), title: 'Rebalance retirement accounts', description: 'Old 401(k) still sitting in a money-market fund. Move it.', group: 'Finance', targetDate: ymd(21), status: 'not-started', profile: 'default', ...stamp },
    piano: { id: id('goal'), title: 'Play three songs on piano from memory', description: 'Twenty minutes a day, working through the beginner course. Weekly lesson with Ms. Elena.', group: 'Learning', targetDate: ymd(90), status: 'not-started', profile: 'default', ...stamp },
};
if (LEGACY) {
    for (const g of Object.values(goals)) delete g.group;
}

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

// Cross-app links: goal -> task (plus legacy focus -> goal under --legacy)
const links = [];
if (LEGACY) {
    const goalFocus = { release: 'career', tenk: 'health', trip: 'family', rebalance: 'finance', piano: 'learning' };
    for (const [gKey, fKey] of Object.entries(goalFocus)) {
        links.push({ id: id('link'), sourceApp: 'focus', sourceId: focus[fKey].id, targetApp: 'goals', targetId: goals[gKey].id, createdAt: iso(-30) });
    }
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
        content: '<p>Puerto Vallarta vs. San Diego. PV wins on price if flights stay under $450.</p><p>Must-do: whale watching (Owen has been asking for a year), one lazy beach day, old town food walk.</p><p>Hotel shortlist in Bookmarks.</p>',
        createdAt: iso(-9, 20), modifiedAt: iso(-2, 21),
    },
    {
        id: id('note'), title: 'Saturday waffles', template: 'blank', tags: ['recipes'], pinned: false, showOnHome: false, profile: 'default',
        content: '<p>2 cups flour, 1 tbsp baking powder, 2 tbsp sugar, pinch of salt.</p><p>2 eggs (whites whipped separately and folded in last), 1¾ cups buttermilk, ½ cup melted butter, splash of vanilla.</p><p>Rest the batter 10 minutes. Waffle iron on medium-high; do not open early. Owen likes his with peanut butter and banana.</p>',
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
    'Owen lost his first tooth and negotiated the tooth fairy up to five dollars. Proud and slightly concerned.',
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
    // sent: true = Emily's own outbound mail (SENT label, read by
    // definition) — seeded so the Inbox's "Waiting on them" thread view
    // has something to show (your message last, quiet >= 3 days).
    const labels = [m.sent ? 'SENT' : 'INBOX'];
    if (!m.read && !m.sent) labels.push('UNREAD');
    if (m.important) labels.push('IMPORTANT');
    if (m.category) labels.push(m.category);
    return {
        messageId: m.id,
        threadId: m.id + '-thr',
        account: DEMO_EMAIL,
        from: m.sent ? `Emily Carter <${DEMO_EMAIL}>` : m.from,
        to: m.sent ? m.to : `Emily Carter <${DEMO_EMAIL}>`,
        cc: '',
        subject: m.subject,
        date: d.toUTCString(),
        messageIdHeader: `<${m.id}@demo.anjadhe.local>`,
        snippet: m.snippet,
        labels,
        isRead: !!(m.read || m.sent),
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
        body: 'Hi Emily,\n\nCan you send the final version of the roadmap deck before the leadership review on Thursday? I want a day to add the budget slide, so end of Wednesday would be perfect.\n\nAlso, nice work on the search latency numbers. They are going straight into the exec summary.\n\nDana',
    }),
    email({
        id: 'demo-msg-oneonone', off: 0, hh: 8, min: 5, read: false, important: true, category: 'CATEGORY_PERSONAL',
        from: 'Sam Torres <sam.torres@fernwoodsoftware.com>',
        subject: 'Can we move our 1:1 to Thursday?',
        snippet: 'Something came up tomorrow afternoon. Could we move our 1:1 to Thursday same time?',
        body: 'Hey Emily,\n\nSomething came up tomorrow afternoon. Could we move our 1:1 to Thursday, same time? I still want to walk through the growth plan, and I have an idea about the mobile track I want to pitch you.\n\nSam',
    }),
    email({
        id: 'demo-msg-renewal', off: -1, hh: 7, min: 30, read: false, important: true, category: 'CATEGORY_UPDATES',
        from: 'TrueShield Insurance <renewals@trueshieldinsurance.com>',
        subject: `Your auto policy renews on ${ymd(10)}`,
        snippet: 'Your TrueShield auto policy is set to renew. Your new six-month premium is $612.50.',
        body: `Dear Emily Carter,\n\nYour TrueShield auto policy #TX-48211 is set to renew on ${ymd(10)}. Your new six-month premium is $612.50, an increase of $38 from your current term.\n\nIf you would like to review coverage options or update your vehicles before renewal, visit your account or call us.\n\nTrueShield Insurance`,
    }),
    email({
        id: 'demo-msg-dentist', off: -2, hh: 11, read: true, important: true, category: 'CATEGORY_UPDATES',
        from: 'Bright Smile Dental <appointments@brightsmiledental.com>',
        subject: `Appointment confirmed: ${ymd(4)} at 2:00 PM`,
        snippet: 'This confirms your cleaning appointment with Dr. Nguyen.',
        body: `Hi Emily,\n\nThis confirms your cleaning appointment with Dr. Nguyen on ${ymd(4)} at 2:00 PM.\n\nPlease arrive 10 minutes early. Reply RESCHEDULE if you need a different time.\n\nBright Smile Dental, Austin`,
    }),
    email({
        id: 'demo-msg-streamnest', off: -1, hh: 6, read: true, category: 'CATEGORY_UPDATES', bundle: 'updates',
        from: 'StreamNest <billing@streamnest.tv>',
        subject: 'Your StreamNest receipt: $15.99',
        snippet: 'Thanks for being a StreamNest member. Your monthly plan renewed at $15.99.',
        body: 'Hi Emily,\n\nThanks for being a StreamNest member. Your Premium plan renewed on your card ending 4482.\n\nAmount charged: $15.99\nNext billing date: one month from today\n\nStreamNest Billing',
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

    // ── Agent use-case mail (docs/COWORK_AGENT.md C8) ─────────────────────
    // A LinkedIn job alert with a full JD in the body — the trigger mail for
    // the tailored-resume automation (the JD must be IN the email so the
    // unattended task can read it with email tools).
    email({
        id: 'demo-msg-linkedin-job', off: 0, hh: 10, min: 20, read: false, category: 'CATEGORY_UPDATES', bundle: 'updates',
        from: 'LinkedIn Job Alerts <jobalerts-noreply@linkedin.com>',
        subject: 'New job for you: Senior Product Manager at Lakeline Robotics',
        snippet: 'Lakeline Robotics is hiring a Senior Product Manager in Austin, TX (hybrid).',
        body: 'Hi Emily,\n\nA new job matches your preferences.\n\nSenior Product Manager, Platform\nLakeline Robotics - Austin, TX (hybrid)\n\nAbout the role:\nOwn the roadmap for our fleet-management platform used by 200+ warehouse customers. Partner with hardware, firmware, and data science teams to ship quarterly releases.\n\nWhat we look for:\n- 5+ years product management in B2B SaaS or robotics\n- Shipped developer-facing platforms or APIs\n- Comfort with metrics-driven prioritization and experimentation\n- Experience working with embedded or hardware teams a plus\n- Clear written communication for exec and customer audiences\n\nView job and apply on LinkedIn.\n\nLinkedIn Job Alerts',
    }),
    // Remittance advice — pairs with the invoice-chasing use case.
    email({
        id: 'demo-msg-remittance', off: 0, hh: 8, min: 45, read: false, important: true, category: 'CATEGORY_UPDATES',
        from: 'Meadow Books LLP <accounts@meadowbooks.example>',
        subject: 'Remittance advice: invoice INV-2031 paid ($1,850.00)',
        snippet: 'Payment of $1,850.00 for invoice INV-2031 was issued today by ACH.',
        body: 'Hello,\n\nPayment of $1,850.00 for invoice INV-2031 was issued today by ACH and should arrive within 2 business days.\n\nReference: INV-2031\nAmount: $1,850.00\n\nMeadow Books LLP, Accounts Payable',
    }),
    // School mail with dates — pairs with the scanned permission slip in the
    // demo files folder. (Id must NOT collide with the Maple Grove
    // newsletter above — a shared 'demo-msg-school' id silently dropped
    // that newsletter for months.)
    email({
        id: 'demo-msg-fieldtrip', off: -1, hh: 15, min: 5, read: false, important: true, category: 'CATEGORY_UPDATES',
        from: 'Oak Hollow Elementary <office@oakhollow-elem.example>',
        subject: `Field trip ${ymd(9)}: permission slip and $12 fee due ${ymd(5)}`,
        snippet: 'The 3rd grade visits the Nature Center. Signed slip and fee are due Friday.',
        body: `Dear families,\n\nThe 3rd grade visits the Travis Nature Center on ${ymd(9)}. Students need a signed permission slip and the $12 activity fee by ${ymd(5)}.\n\nPack a sack lunch and a refillable water bottle. Buses leave at 8:45 AM sharp and return by 2:30 PM.\n\nOak Hollow Elementary`,
    }),

    // ── Trips demo material (2026-08-10: EmailTrips clusters reservation
    // insights into trips by date arithmetic) ────────────────────────────
    // A near-term work trip: round-trip flight + hotel over the same span.
    // With --baked both carry structured reservation facts, so the home
    // Trips card ("Trip · Seattle"), the trip view, and the Email AI
    // Trips bundle index all render; without --baked the live reservation
    // extractor produces the same facts.
    email({
        id: 'demo-msg-seaflight', off: -3, hh: 12, min: 10, read: true, category: 'CATEGORY_UPDATES', bundle: 'travel',
        from: 'Aerolane Airlines <confirmations@aerolane.com>',
        subject: `Booking confirmed: AUS to SEA, ${ymd(9)} - ${ymd(12)}`,
        snippet: 'Confirmation code AER3K9. Austin (AUS) to Seattle (SEA), 1 traveler.',
        body: `Your booking is confirmed.\n\nConfirmation code: AER3K9\nOutbound: ${ymd(9)}, AUS 10:05 AM to SEA 12:40 PM\nReturn: ${ymd(12)}, SEA 6:30 PM to AUS 12:05 AM\nTravelers: 1\n\nManage your booking online with your confirmation code.\n\nAerolane Airlines`,
    }),
    email({
        id: 'demo-msg-seahotel', off: -3, hh: 14, min: 25, read: true, category: 'CATEGORY_UPDATES', bundle: 'travel',
        from: 'The Marlowe Seattle <reservations@marlowehotels.com>',
        subject: `Reservation confirmed: ${ymd(9)} - ${ymd(12)}, The Marlowe Seattle`,
        snippet: 'Confirmation MRL-58214. King room, 3 nights, check-in from 3:00 PM.',
        body: `Dear Emily Carter,\n\nWe look forward to welcoming you.\n\nConfirmation: MRL-58214\nCheck-in: ${ymd(9)}, from 3:00 PM\nCheck-out: ${ymd(12)}, by 11:00 AM\nRoom: King, city view\n\nFree cancellation until ${ymd(7)}.\n\nThe Marlowe Seattle`,
    }),

    // Outbound mail gone quiet — gives the Inbox's "Waiting on them"
    // computed view a row (your message last in thread, quiet >= 3 days).
    email({
        id: 'demo-msg-quote', off: -4, hh: 9, min: 40, sent: true,
        to: 'Rojas Fencing <victor@rojasfencing.example>',
        subject: 'Backyard fence quote',
        snippet: 'Could you send over the quote we discussed for the cedar fence?',
        body: 'Hi Victor,\n\nGreat meeting you Saturday. Could you send over the quote we discussed for the cedar fence, including the gate hardware?\n\nWe would love to get on your schedule before fall.\n\nThanks,\nEmily',
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
        // Structured booking facts, exactly the shape _validateReservation
        // stores — what EmailTrips clusters into trips.
        ...(a.reservation ? { reservation: a.reservation } : {}),
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
        type: 'receipt', priority: 'medium', analyzedAt: iso(-1, 8), amount: '$15.99',
        insights: ['This subscription has renewed monthly all year', 'Cancel or downgrade anytime from the StreamNest account page'],
        summary: 'StreamNest charged $15.99 for another month, a recurring subscription worth a look.',
    }),
    'demo-msg-utility': analysis({
        type: 'bill', priority: 'medium', analyzedAt: iso(-2, 9), readAt: iso(-1, 8), amount: '$184.32',
        action: 'Pay Austin Utilities bill', dueDate: ymd(6),
        insights: ['Autopay enrollment is available'],
        summary: `Austin Utilities statement of $184.32 is due ${ymd(6)}.`,
    }),
    'demo-msg-flight': analysis({
        type: 'reservation', priority: 'low', analyzedAt: iso(-2, 16), readAt: iso(-1, 8),
        insights: ['Confirmation code AER8Q2', 'Three travelers, Dec 12 to Dec 22'],
        summary: 'December trip flights are booked: Austin to Puerto Vallarta, Dec 12 to Dec 22.',
        reservation: {
            kind: 'flight', vendor: 'Aerolane Airlines', confirmationCode: 'AER8Q2',
            start: `${now.getFullYear()}-12-12T10:40`, end: `${now.getFullYear()}-12-12T13:05`,
            returnStart: `${now.getFullYear()}-12-22T14:20`, returnEnd: `${now.getFullYear()}-12-22T18:45`,
            from: 'Austin', to: 'Puerto Vallarta', place: null, status: 'confirmed', cancelBy: null, allDay: false,
        },
    }),
    'demo-msg-seaflight': analysis({
        type: 'reservation', priority: 'medium', analyzedAt: iso(-3, 13), readAt: iso(-2, 8),
        insights: ['Confirmation code AER3K9', 'The return lands after midnight — book the airport ride ahead'],
        summary: `Flight booked: Austin to Seattle, ${ymd(9)} to ${ymd(12)}, confirmation AER3K9.`,
        reservation: {
            kind: 'flight', vendor: 'Aerolane Airlines', confirmationCode: 'AER3K9',
            start: `${ymd(9)}T10:05`, end: `${ymd(9)}T12:40`,
            returnStart: `${ymd(12)}T18:30`, returnEnd: null,
            from: 'AUS', to: 'SEA', place: null, status: 'confirmed', cancelBy: null, allDay: false,
        },
    }),
    'demo-msg-seahotel': analysis({
        type: 'reservation', priority: 'medium', analyzedAt: iso(-3, 15), readAt: iso(-2, 8),
        insights: [`Free cancellation until ${ymd(7)}`, 'Check-in from 3:00 PM'],
        summary: `Three nights at The Marlowe Seattle, ${ymd(9)} to ${ymd(12)}, confirmation MRL-58214.`,
        reservation: {
            kind: 'lodging', vendor: 'The Marlowe Seattle', confirmationCode: 'MRL-58214',
            start: ymd(9), end: ymd(12), returnStart: null, returnEnd: null,
            from: null, to: null, place: 'Seattle', status: 'confirmed', cancelBy: ymd(7), allDay: true,
        },
    }),
    'demo-msg-fieldtrip': analysis({
        type: 'deadline', priority: 'high', analyzedAt: iso(-1, 16), amount: '$12.00',
        action: 'Sign the field trip permission slip and send the $12 fee', dueDate: ymd(5),
        insights: [`The 3rd grade visits the Travis Nature Center on ${ymd(9)}`, 'Pack a sack lunch and a refillable water bottle'],
        summary: `Permission slip and $12 fee are due ${ymd(5)} for the ${ymd(9)} field trip.`,
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

/* ---------- demo files + agent automations (docs/COWORK_AGENT.md C8) ----
 *
 * A folder of realistic paperwork the agent can actually open (C8.2 reads
 * pdf/xlsx/docx/csv/scans), organize (C8.4 undo), and watch (C8.5 file
 * triggers). Lives INSIDE the demo root so `rm -rf` resets everything; it
 * is outside the agent's default ~/Anjadhe scope, so either approve the
 * folder grant when the agent first asks (a good demo of C1 in itself) or
 * launch with ANJADHE_APPS_DIR pointing at it for promptless runs.
 *
 * The documents are REALISTIC files checked into the repo at
 * scripts/demo-files/ — laid-out PDF invoices and statements (text layer),
 * scanned image-only bills/receipts (OCR path), a real xlsx job sheet, a
 * docx resume. Regenerate with scripts/generate-demo-fixtures.{js,py};
 * amounts are load-bearing (INV-2031 $1,850 matches the remittance email,
 * the utility bill's $482.19 / Aug 15 is cited in docs).
 */
const DEMO_FILES = path.join(ROOT, 'Anjadhe Demo');
const month = ymd(0).slice(0, 7);
const SRC_FILES = path.join(__dirname, 'demo-files');
const copyDemo = (src, destRel) => {
    try {
        const dest = path.join(DEMO_FILES, destRel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(path.join(SRC_FILES, src), dest);
    } catch (e) { console.warn('  (demo file missing: ' + src + ' — ' + e.message + ')'); }
};
copyDemo('invoice-2031-meadow-books.pdf', path.join('Invoices', month, 'invoice-2031-meadow-books.pdf'));
copyDemo('invoice-2032-cedar-labs.pdf', path.join('Invoices', month, 'invoice-2032-cedar-labs.pdf'));
copyDemo('invoice-2033-north-pier.pdf', path.join('Invoices', month, 'invoice-2033-north-pier.pdf'));
// Bills addressed TO the user, meant to be EMAILED to yourself as an
// attachment (nothing seeds them into the inbox — attachment bytes come from
// Gmail, so only a real message has them). The covering mail should say only
// "please see attached": the amount and the Sep 12 due date exist ONLY inside
// the PDF, which is the case that produced a made-up due date before
// read_email_attachment / _enrichFromAttachment existed.
copyDemo('email-invoice-northgate.pdf', path.join('Email test', 'email-invoice-northgate.pdf'));
copyDemo('email-invoice-injection-test.pdf', path.join('Email test', 'email-invoice-injection-test.pdf'));
copyDemo('bank-statement.pdf', path.join('Statements', 'bank-statement.pdf'));
copyDemo('scanned-utility-bill.pdf', path.join('Scans', 'scanned-utility-bill.pdf'));
copyDemo('jobsheet-week.xlsx', path.join('JobSheets', 'jobsheet-week.xlsx'));
copyDemo('fall-soccer-schedule.pdf', path.join('School', 'fall-soccer-schedule.pdf'));
// The un-filed pile for the "organize my ToFile folder" (and undo) demo.
copyDemo('scanned-receipt-hardware.pdf', path.join('ToFile', 'scanned-receipt-hardware.pdf'));
copyDemo('manual-dishwasher-DW450.pdf', path.join('ToFile', 'manual-dishwasher-DW450.pdf'));
copyDemo('brokerage-statement-june.pdf', path.join('ToFile', 'brokerage-statement-june.pdf'));
copyDemo('baseline-resume.docx', path.join('Resumes', 'baseline-resume.docx'));
fs.mkdirSync(path.join(DEMO_FILES, 'Drop'), { recursive: true });

// Price-watch note — the target the Amazon automation appends to.
notes.push({
    id: id('note'), title: 'Price Watch: Sony WH-1000XM5', template: 'blank', tags: ['personal'], pinned: false, showOnHome: false, profile: 'default',
    content: `<p>Target: $299 or less (birthday gift for Mark).</p><p>History:</p><p>${ymd(-12)}: $348.00</p><p>${ymd(-5)}: $329.99</p>`,
    createdAt: iso(-12, 9), modifiedAt: iso(-5, 9),
});

// Pre-armed automations, still written in the C8.5 `agent-automations`
// shape. C10 (2026-08-03) merged Automations into Routines, and this key is
// exactly what PromptFeed._migrateAutomations converts on first launch — so
// seeding it still works, and each of these becomes a `runMode:'task'`
// routine homed to this Mac. Kept in the old shape deliberately: it also
// exercises the migration every time the demo data is seeded.
//
// All dated NOW, so nothing fires on first launch: time triggers wait for
// their next slot, the email trigger only matches mail newer than the
// arming. Demo them with "Run now" on the Routines page.
const automation = (goal, trigger) => ({
    id: id('auto'), goal, trigger, enabled: true,
    createdAt: new Date().toISOString(), lastRunAt: null, lastTaskId: null, lastError: null,
});
const demoAutomations = [
    automation(
        // Wording matters: the task engine's intake gate (I1) blocks goals
        // that REFER to material ("that email", "the resume") when the
        // material isn't in hand. This goal instead tells the run where to
        // FETCH everything with its own tools, so it passes the gate on a
        // triggered or manual run alike.
        `A new LinkedIn job alert arrived. Use your email tools to open the newest message from LinkedIn Job Alerts and read its job description. Then use your file tools to read Emily's baseline resume: ${path.join(DEMO_FILES, 'Resumes', 'baseline-resume.docx')}. Create a note titled "Tailored resume: <job title>" containing the tailored resume, written in ONE pass as a single document. Plan this as THREE simple steps — read the email, read the resume file, write the note — never a per-item or per-line loop. Reorder and reword real experience from the baseline only; never invent experience or skills that are not in the baseline.`,
        { type: 'email', from: 'linkedin.com' }),
    automation(
        // Same intake-gate lesson as the LinkedIn goal above: say where to
        // FETCH the material ("open the newly arrived file at the path the
        // run names"), never refer to it as given ("read it", "the
        // document") — the I1 pre-filter reads those as missing input.
        `A new file landed in ${path.join(DEMO_FILES, 'Drop')} (the run names its exact path). Use your file tools to open the newly arrived PDF or image at that path, then create ONE schedule task titled with the vendor and amount (e.g. "Pay Acme $120 quote"), due on any date named inside. One task, nothing else.`,
        { type: 'file', folder: path.join(DEMO_FILES, 'Drop') }),
    automation(
        'Check the current price of the Sony WH-1000XM5 headphones on amazon.com. Use the browser tools if a browser connection is available, otherwise web_search and read_url. Append one line to the note "Price Watch: Sony WH-1000XM5" in the form "<today\'s date>: $<price>". If the price is at or below $299, also create a schedule task "Buy the WH-1000XM5 (price target hit)" due today.',
        { type: 'time', interval: 'daily', time: '09:00' }),
    automation(
        'Write the "Week ahead" note: read the schedule for the next 7 days and any unread school emails, and create or update a note titled "Week ahead" listing who needs to be where on which day, anything due, and anything to pack or bring.',
        { type: 'time', interval: 'weekly', time: '17:00' }),
];

/* ---------- portfolio strategy + scheduled reviews ---------- */

// One active strategy over the investment accounts, shaped exactly like
// PortfolioStrategy.save() writes it. Targets sit inside their bands
// against the seeded holdings (~58% index, ~23% single stocks, ~19% cash),
// so the Strategy page and check_strategy read "On plan" — computed from
// the real numbers, honest for the overview demo.
const strategy = {
    id: id('strat'),
    name: 'Balanced Growth',
    objective: 'Grow long-term savings for retirement and college without betting the family\'s future on any single company.',
    horizon: '15+ years. Retirement money first, college second.',
    riskLevel: 'Moderate: fine with market swings, not with concentrated losses.',
    thesis: 'Low-cost index funds as the core, a few conviction stocks kept small, cash for near-term needs.',
    coverage: 'Covers all four accounts. Ally Savings is the cash sleeve and doubles as the emergency fund.',
    reviewCadence: 'Weekday mornings, plus a deeper look each quarter.',
    targets: [
        { id: id('tgt'), label: 'Index core', tickers: ['VTI', 'VFIFX'], includeCash: false, targetPct: 60, minPct: 52, maxPct: 68 },
        { id: id('tgt'), label: 'Single stocks', tickers: ['AAPL', 'MSFT'], includeCash: false, targetPct: 20, minPct: 12, maxPct: 25 },
        { id: id('tgt'), label: 'Cash', tickers: [], includeCash: true, targetPct: 20, minPct: 10, maxPct: 30 },
    ],
    rules: [
        { id: id('rule'), kind: 'max_position', value: 15, exclude: ['VTI', 'VFIFX'], text: 'No single stock above 15% of the portfolio (index funds excluded).' },
        { id: id('rule'), kind: 'min_cash', value: 5, text: 'Keep at least 5% in cash for near-term needs.' },
        { id: id('rule'), kind: 'custom', text: 'New money goes to whichever sleeve is furthest below its target.' },
    ],
    isDefault: true,
    status: 'active',
    createdAt: iso(-200, 10),
    updatedAt: iso(-30, 10),
    history: [
        { at: iso(-30, 10), summary: 'Updated targets' },
        { at: iso(-200, 10), summary: 'Created' },
    ],
};

// Scheduled reviews for the strategy and a goal — ordinary routines
// (prompt notes), the exact records the "Review it every weekday morning"
// and save_goal startWeeklyReview buttons create (bodies verbatim from
// PortfolioStrategyPage._startReviews / GoalInterview._reviewBody). Never
// run yet, so each fires its catch-up on first launch and the review post
// lands in the Home feed — which is the point the overview demo makes.
const promptNote = (title, body, config, dayOffset) => ({
    id: id('note'), title, content: `<p>${body}</p>`, tags: [],
    template: 'prompt',
    prompt: { target: 'agent', offline: true, trigger: null, runMode: 'digest', homeMachineId: null, voiceId: null, ...config },
    pinned: false, createdAt: iso(dayOffset, 10), modifiedAt: iso(dayOffset, 10),
});
// BAKED-only: these never-run routines FIRE on first boot (the demo wants
// their catch-up posts in the feed), and that background activity races
// the agent-eval journeys' own seeding — the eval harness seeds WITHOUT
// --baked (proved 2026-08-22: c10-get-email-admits-attachments lost its
// seeded account to a concurrent email-blob write). Demo recordings
// always seed --baked, so the demos keep them.
if (BAKED) notes.push(promptNote(
    'Strategy Review: Balanced Growth',
    'Review my investment strategy "Balanced Growth" as of today. ' +
    'Call get_strategy and check_strategy for "Balanced Growth", refresh_portfolio_prices, and read my holdings with list_portfolio. ' +
    'Use web search for market context relevant to this strategy’s targets and my holdings (rates, sectors, major moves). ' +
    'Then write a short plain review: whether the strategy still fits current market conditions, any drift or breach using only check_strategy’s computed numbers, and what, if anything, deserves attention today. ' +
    'If nothing changed and nothing is off plan, say so in two sentences and stop.',
    { interval: 'weekdays', time: '08:00', web: true, useContext: true }, -30));
if (BAKED) notes.push(promptNote(
    'Goal Review: Run a 10K in under an hour',
    'Review my goal "Run a 10K in under an hour". Call list_goals and look at the tasks linked to it: what got done since the last review, what is scheduled next, and how long it has been since anything moved. ' +
    'Check the goal\'s ageDays first: a goal only days old is JUST STARTING, never "stalled" — for a new goal, judge whether the first steps are scheduled and say it is under way. ' +
    'For an established goal, write a short honest read: is it moving, stalled, or done in all but name? If it is stalled, name the smallest next step worth scheduling. ' +
    'If nothing changed since the last review, say so in two sentences and stop.',
    { interval: 'weekly', time: '09:00', web: false, useContext: true }, -45));

/* ---------- writing voice (Library) ---------- */

// Three pieces Emily "wrote", on disk where the Library reads them
// (<root>/Anjadhe/library/<collection>/), plus a pre-studied voice record
// in the `library` blob — the --baked recipe applied to Voice: the demo
// shows a studied voice without needing the semantic index or a live
// study pass. The exemplars below are VERBATIM passages from these files
// (the quote-anchor law: a nomination that is not real writing is not
// evidence of anything).
const VOICE_COLLECTION = 'My writing';
const voiceDocs = {
    'shipping-the-fleet-dashboard.md': `# What shipping the fleet dashboard taught me

We shipped the fleet dashboard on a Tuesday. By Friday, three customers had built their morning standup around it. That is the whole job, honestly. Not the roadmap, not the deck. Somebody's Tuesday getting easier.

The part nobody tells you about analytics products: the first version of every chart is wrong. Not broken. Wrong. It answers the question you asked instead of the question the customer has. We rebuilt the utilization view four times before a warehouse lead in Ohio told us she just wanted to know which robots would need a charge before the noon rush. Four rebuilds, one sentence.

So here is what I do now. Before any feature brief, I write the sentence the customer would say out loud when it works. If I cannot write that sentence, the feature is not ready to build. It sounds simple. It has saved us a quarter of wasted work, twice.

The dashboard is not done. Dashboards are never done. But it earned a place in somebody's morning, and that is the only metric I fully trust.`,
    'running-notes-summer.md': `# Running in an Austin summer, a survival guide

Nobody trains for a 10K in Austin in August on purpose. You sign up in April, when the weather is a lie, and then July arrives to collect.

Here is my system, learned the hard way. Run before the sun gets serious, which means 6am, which means laying everything out the night before because at 5:40 I cannot be trusted to find two matching socks. Carry more water than feels dignified. Walk the hills without apologizing to anyone.

The surprise is that I stopped hating it. There is a version of the town lake trail at dawn, herons standing in the shallows, that nobody driving to work at nine will ever see. I get it to myself, plus a few dozen other people who also signed up for something in April.

My knee has opinions some weeks. I listen, mostly. The plan says three runs a week and the plan is a suggestion the way gravity is a suggestion, which is to say I argue and it wins.

Race day is in October. I will not be fast. I will be there, which four months ago was not obvious.`,
    'note-to-the-team.md': `# Note to the team, end of quarter

I want to say the quiet thing plainly. This quarter was heavy. Two launches, a reorg nobody asked for, and a support queue that did not care about either.

You did it anyway. Not with heroics, which burn out, but with the boring virtues. You wrote things down. You handed work off cleanly. You said "I am stuck" out loud, early, in public, which is the single most underrated professional skill I know.

One ask for next quarter. Guard your mornings. The calendar will eat whatever you leave uncovered, and deep work does not happen in the gaps between meetings. Block the time and treat it like a customer commitment, because it is one. The customer is the version of you at the end of next quarter.

Rest this weekend. The queue will keep. It always keeps.`,
};
const voiceDir = path.join(ROOT, 'Anjadhe', 'library', VOICE_COLLECTION);
fs.mkdirSync(voiceDir, { recursive: true });
for (const [file, text] of Object.entries(voiceDocs)) fs.writeFileSync(path.join(voiceDir, file), text);

const voiceExemplar = (docTitle, text, n) => ({
    id: 'ex_demo_' + n, collection: VOICE_COLLECTION,
    docId: VOICE_COLLECTION + '/' + docTitle, docTitle, text,
    source: 'study', pinned: false, createdAt: iso(-2, 9), updatedAt: iso(-2, 9),
});
const voicePage = {
    id: 'voice_' + VOICE_COLLECTION,
    name: 'My voice',
    collection: VOICE_COLLECTION,
    body: [
        'Short declarative sentences, with an occasional long one that earns its length. Cuts to the point in the first paragraph, then backs it with one concrete story rather than three abstract claims.',
        'Concrete over general: named details (a warehouse lead in Ohio, herons in the shallows, 5:40am socks) instead of adjectives. Numbers stated plainly.',
        'Warm, dry humor delivered deadpan, usually at her own expense. Never sarcastic about other people.',
        'Speaks directly to the reader ("Here is my system", "One ask"). Comfortable saying the quiet thing plainly; names hard truths without drama.',
        'Favors "which is to say", "honestly", and sentence fragments for emphasis. That is the whole job. Avoids exclamation points, buzzwords, and hedging.',
        'Endings land on a short, earned line that reframes the piece rather than summarizing it.',
    ].join('\n\n'),
    lastStudiedAt: iso(-2, 9),
    sampledDocs: 3,
    createdAt: iso(-10, 9),
    updatedAt: iso(-2, 9),
};
const voiceExemplars = [
    voiceExemplar('shipping-the-fleet-dashboard.md',
        "That is the whole job, honestly. Not the roadmap, not the deck. Somebody's Tuesday getting easier.", 1),
    voiceExemplar('running-notes-summer.md',
        'Nobody trains for a 10K in Austin in August on purpose. You sign up in April, when the weather is a lie, and then July arrives to collect.', 2),
    voiceExemplar('note-to-the-team.md',
        'You said "I am stuck" out loud, early, in public, which is the single most underrated professional skill I know.', 3),
];

const put = db.prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)');
const set = (k, v) => put.run('app_' + k, JSON.stringify(v));
const putEmail = db.prepare('INSERT OR REPLACE INTO emails (messageId, account, internalDate, isRead, isStarred, labels, data) VALUES (?, ?, ?, ?, ?, ?, ?)');
const putBody = db.prepare('INSERT OR REPLACE INTO email_bodies (messageId, bodyText, bodyHtml) VALUES (?, ?, ?)');

db.transaction(() => {
    set('profiles', { profiles: [{ id: 'default', name: 'Default', createdAt: iso(-900), modifiedAt: iso(-900) }] });
    if (LEGACY) set('focus', { focusItems: Object.values(focus) });
    set('goals', { goals: Object.values(goals) });
    set('schedule', { scheduleItems: tasks, emailActionLedger });
    set('links', { links });
    set('tags', { tags });
    set('notes', { notes });
    set('journal', { entries: journalEntries });
    set('bookmarks', { bookmarks, groups: bookmarkGroups.map((name) => ({ name, createdAt: iso(-20) })) });
    // Volatile-data law (2026-07-30): the portfolio blob carries only
    // user-edited records; snapshots live in their own portfolio-history
    // key (quotes stay in localStorage and are fetched live).
    set('portfolio', { accounts: Object.values(acct), transactions, properties, strategies: [strategy] });
    set('portfolio-history', { snapshots: valueHistory });
    set('promptFeed', { items: [], runs: {} });
    set('actionsSettings', { aiFiling: true });
    set('library', { voicePages: [voicePage], exemplars: voiceExemplars, tombstones: {} });
    // The demo brain: Ram's Mac Studio llama-server, pre-selected so the
    // instance is AI-ready on first launch (no per-take model setup, and
    // the recorder's prep() keeps an already-configured model).
    // modelListVersion 2 marks the migration done; ensureModelList then
    // re-asserts the brain→provider sync on boot, so background AI (email
    // insights, routines) reaches this server too.
    set('agent-settings', {
        modelList: [{
            id: 'entry_demo_server', engine: 'server',
            model: 'Qwen3.6-35B-A3B-Q8_0.gguf',
            baseUrl: 'http://rams-mac-studio:8081/v1',
            label: 'Qwen3.6 35B · Mac Studio',
        }],
        defaultModelId: 'entry_demo_server',
        selectedModel: 'Qwen3.6-35B-A3B-Q8_0.gguf',
        modelListVersion: 2,
    });
    // Armed agent automations (C8.5 key) — migrated into routines on first
    // launch and shown on the Routines page; nothing fires until its trigger
    // genuinely occurs (see above).
    set('agent-automations', demoAutomations);

    // Mock inbox: unified account registry, EmailApp state, priority
    // senders, and the cached messages themselves.
    set('accounts', {
        migratedFromLegacy: true,
        accounts: [{
            id: 'acc_demo1', provider: 'google', email: DEMO_EMAIL, displayName: 'Emily Carter',
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
    // Folder taxonomy current as of 2026-08-03 (one noun per folder).
    set('emailInsightSettings', {
        autoDetect: true,
        enabledTypes: { bill: true, receipt: true, renewal: true, appointment: true, reservation: true, delivery: true, deadline: true, code: true, security: true, general: true },
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
console.log('  Agent demo: ' + demoAutomations.length + ' armed automations, demo paperwork in ' + DEMO_FILES);
console.log('  (PDF invoices + statements, scanned bill/receipt for OCR, xlsx job sheet, soccer flyer, docx resume, a Drop/ watch folder)');
console.log('  "Email test/": mail these to yourself with a body of only "please see attached" —');
console.log('    email-invoice-northgate.pdf       $1,777.47 due Sep 12, both PDF-only');
console.log('    email-invoice-injection-test.pdf  same bill + an injected instruction; expect it ANALYSED, never obeyed');
console.log('  The agent will ask once for access to that folder; approve it, or launch with ANJADHE_APPS_DIR="' + DEMO_FILES + '" to pre-scope it.');
console.log('Launch with: ANJADHE_DATA_ROOT=' + ROOT + ' npm start');
