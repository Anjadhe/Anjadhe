// The phone builds the Tasks view itself when the Mac is away
// (ios-engine/.../AnjadheCore/TaskList.swift, docs/MOBILE_NATIVE.md "M5").
// Drift between that copy and the desktop is the known risk, so both sides
// are pinned to ONE golden file: this test runs the desktop's real code
// (MobileViews._tasks over ScheduleApp + ActionsApp) on a fixture and
// compares it with the golden; the Swift TaskListParityTests compare the
// phone's port with the same golden. A desktop rule change fails here first:
// re-run with --update, then make the Swift port pass.
process.env.TZ = 'UTC';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const R = path.join(__dirname, '..') + '/';
const FIX = R + 'ios-engine/Anjadhe/Tests/AnjadheCoreTests/Fixtures/';
const fx = JSON.parse(fs.readFileSync(FIX + 'task-list-parity.input.json', 'utf8'));

const noop = () => {};
const store = { schedule: { scheduleItems: fx.items }, goals: { goals: fx.goals } };
Object.assign(globalThis, {
    window: globalThis,
    document: { getElementById: () => null, querySelectorAll: () => [], querySelector: () => null, addEventListener: noop, createElement: () => ({ style: {}, classList: { add: noop } }) },
    localStorage: { getItem: () => null, setItem: noop },
    StorageManager: { get: (k) => store[k] || null, set: noop },
    LinkManager: { loadLinks: () => fx.links },
    AppManager: { register: noop }, UIUtils: { escapeHtml: (s) => String(s) },
    FEATURES: { isEnabled: () => false },
});
const load = (f) => (0, eval)(fs.readFileSync(R + f, 'utf8').replace(/^const (\w+) =/m, 'globalThis.$1 ='));
load('js/components/task-list.js');
load('js/apps/schedule/schedule-app.js');
load('js/apps/actions/actions-app.js');
load('js/agent/mobile-views.js');
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
ScheduleApp.getLocalToday = () => fx.today;
ScheduleApp.getLocalDate = (n) => { const d = new Date(fx.today + 'T00:00:00'); d.setDate(d.getDate() + n); return iso(d); };
TaskListUI._today = () => fx.today;
ScheduleApp.scheduleItems = fx.items;
ScheduleApp.loadData = noop;
MobileViews._tasksReady = noop;

(async () => {
    const out = {};
    for (const slice of ['today', 'tomorrow', 'week', 'month', 'later', 'all']) {
        for (const group of [null, 't:home', 't:*', 'g:Home', 'g:', 'g:Work', 'unassigned', 'src:email', 'src:imessage']) {
            out[slice + '|' + (group || '')] = await MobileViews._tasks({ slice, group });
        }
    }
    const goldenPath = FIX + 'task-list-parity.golden.json';
    if (process.argv.includes('--update')) {
        fs.writeFileSync(goldenPath, JSON.stringify(out, null, 1) + '\n');
        console.log('task-list-parity-test: golden updated (' + Object.keys(out).length + ' views)');
        return;
    }
    const golden = JSON.parse(fs.readFileSync(goldenPath, 'utf8'));
    assert.deepStrictEqual(out, golden, 'the desktop Tasks view changed — run with --update, then make TaskList.swift match');
    console.log('task-list-parity-test: ok (' + Object.keys(out).length + ' views)');
})().catch((e) => { console.error(e.message || e); process.exit(1); });
