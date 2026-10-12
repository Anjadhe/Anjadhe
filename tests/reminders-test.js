// The reminder notifier (AppManager.setupScheduleNotifications, 2026-10-11)
// reads commitments: today's occurrence at that day's own time, the early
// ring from `remind`, a one-time dated one's 9:00 notice on the day and on
// the days before it asked for, and nothing for one done or dropped.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const store = {};
global.StorageManager = { get: k => store[k] ? JSON.parse(JSON.stringify(store[k])) : null, set: (k, v) => { store[k] = JSON.parse(JSON.stringify(v)); } };
global.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
const C = require('../js/core/commitments.js');
C._inited = true;

function ringAt(iso, items) {
    store[C.KEY] = { items, ledger: [], tombstones: {} };
    C._data = null;
    const shown = [];
    const RealDate = Date;
    class FixedDate extends RealDate { constructor(...a) { if (a.length) super(...a); else super(iso); } static now() { return new RealDate(iso).getTime(); } }
    const ctx = {
        console, Date: FixedDate, Math, JSON, Number, String, Array, Object, Set, Map,
        window: {}, document: { addEventListener() {} },
        localStorage: global.localStorage, StorageManager: global.StorageManager,
        Notification: { permission: 'granted' }, Commitments: C,
        Notify: { show: (title, body, opts) => shown.push({ title, body, opts }), forwardActive: () => false },
        setInterval: () => 0
    };
    ctx.window.Notification = ctx.Notification;
    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/core/app-manager.js'), 'utf8') + '\nthis.AppManager = AppManager;', ctx);
    ctx.AppManager.setupScheduleNotifications();
    return shown;
}
const at = '2026-10-01T06:00:00Z';
const day = '2026-10-12';
const mk = (id, extra) => ({ ...C.blank(id, at), title: id, ...extra });

// 7:50: the early ring of a 8:00 habit with a 10-minute reminder.
let shown = ringAt(`${day}T07:50:00`, [
    mk('walk', { when: { date: '2026-10-01', time: '08:00', end: '08:30' }, repeat: { rule: 'daily', days: [] }, remind: { minutesBefore: 10, daysBefore: [] } })
]);
assert.equal(shown.length, 1);
assert.match(shown[0].body, /^Starting in 10 min, today at 8:00 AM - 8:30 AM/);

// 8:00: rings at the start; a day already done does not; a moved day rings at its own time.
shown = ringAt(`${day}T08:00:00`, [
    mk('walk', { when: { date: '2026-10-01', time: '08:00', end: null }, repeat: { rule: 'daily', days: [] } }),
    mk('read', { when: { date: '2026-10-01', time: '08:00', end: null }, repeat: { rule: 'daily', days: [] }, history: { [day]: 'done' } }),
    mk('swim', { when: { date: '2026-10-01', time: '08:00', end: null }, repeat: { rule: 'daily', days: [] }, moved: { [day]: { time: '18:00' } } })
]);
assert.deepEqual(shown.map(s => s.title), ['walk'], 'only the one still due at 8:00 today');
assert.match(shown[0].body, /^Starting now, today at 8:00 AM/);

// 9:00: a one-time dated commitment on its day and on a day before it asked for; with its project and email.
const goal = mk('Kitchen remodel', { kind: 'project' });
shown = ringAt(`${day}T09:00:00`, [
    goal,
    mk('call', { parent: goal.id, note: 'Ask about the quote', when: { date: day, time: null, end: null }, origin: { kind: 'email', ref: 'm1', from: 'Ana', subject: 'Quote' } }),
    mk('pay', { when: { date: '2026-10-14', time: '17:00', end: null }, remind: { minutesBefore: null, daysBefore: [2] } }),
    mk('later', { when: { date: '2026-10-20', time: null, end: null } }),
    mk('gone', { state: 'dropped', when: { date: day, time: null, end: null } })
]);
assert.deepEqual(shown.map(s => s.title).sort(), ['call', 'pay']);
const call = shown.find(s => s.title === 'call');
assert.match(call.body, /^Due today\nAsk about the quote\nPart of: Kitchen remodel\nFrom email: Ana · Quote$/);
assert.match(shown.find(s => s.title === 'pay').body, /^Due in 2 days, .* at 5:00 PM/);
assert.equal(call.opts.phone.project, 'Kitchen remodel');
console.log('reminders: today at its own time, the early ring, the 9:00 notices, nothing for done or dropped; passed');
