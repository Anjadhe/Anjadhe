// The phone channel offers the Mac's LIVE data with its own stamps
// (2026-10-02). Before this, readMacSyncSet read the iCloud journal, which
// stopped being written when Mac-to-Mac sync was retired (2026-09-30): the
// phone kept tasks the Mac had deleted, and a phone edit could put the
// phone's stale copy back over the Mac. Runs main.js's own code, cut out by
// text (main.js is the Electron main process and cannot be required here).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
const start = src.indexOf("// The Mac's syncable dataset, as the phone sees it");
const end = src.indexOf('// Merge the phone\'s set into the Mac, then hand the Mac\'s set back.');
assert(start > 0 && end > start, 'channel sync code not found in main.js');
const mStart = src.indexOf('// Stage 1 of the delta sync');
const mEnd = src.indexOf('// Advertise the Mac\'s current LAN relay addresses');
assert(mStart > 0 && mEnd > mStart, 'manifest code not found in main.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-stamps-'));
function load(store) {
    const deps = {
        fs, path, crypto: require('crypto'),
        app: { getPath: () => dir },
        SYNC_EXCLUDE_KEYS: new Set(['app_device-local']),
        RECORD_MERGED_KEYS: new Set(),
        mergeRecordBlobs: (k, a, b) => b,
        mergePhoneEdit: require('../js/main/three-way-merge').mergePhoneEdit,
        notifyChannelDataChanged: () => {},
        dataStore: {
            getAll: () => JSON.parse(JSON.stringify(store)),
            get: (k) => store[k],
            set: (k, v) => { store[k] = v; },
            delete: (k) => { delete store[k]; },
        },
    };
    const body = src.slice(start, end) + '\n' + src.slice(mStart, mEnd)
        + '\nreturn { readMacSyncSet, stampChannelKey, applyPhoneChange, applyPhoneDelete, handleSyncManifest, handleSyncValues, saveChannelStamps };';
    return new Function(...Object.keys(deps), body)(...Object.values(deps));
}
const log = console.log; console.log = () => {};
const later = (ms) => new Date(Date.now() + ms).toISOString();
const earlier = (ms) => new Date(Date.now() - ms).toISOString();

// (7 runs before 6, which reloads from disk.)
const store = { app_schedule: { scheduleItems: [{ id: 'live' }] }, 'app_device-local': { x: 1 } };
const S = load(store);

// 1. First exchange: the Mac's live value, stamped at the seed, beats a phone
//    copy stamped before the seed (the ghost tasks).
{
    const set = S.readMacSyncSet(true);
    assert.deepStrictEqual(set.app_schedule.value, { scheduleItems: [{ id: 'live' }] }, 'value comes from the live store');
    assert(!set['app_device-local'], 'excluded keys are never offered');
    const plan = S.handleSyncManifest({ app_schedule: earlier(3600e3) });
    assert(plan.send.app_schedule, 'Mac wins the first exchange');
    assert.deepStrictEqual(plan.want, []);
}

// 2. A Mac write is stamped when it happens, and goes down.
{
    const before = S.readMacSyncSet(true).app_schedule.modifiedAt;
    store.app_schedule = { scheduleItems: [] };
    S.stampChannelKey('app_schedule');
    const after = S.readMacSyncSet(true).app_schedule;
    assert(after.modifiedAt >= before);
    assert.deepStrictEqual(after.value, { scheduleItems: [] });
    const plan = S.handleSyncManifest({ app_schedule: before });
    assert(plan.send.app_schedule, 'a Mac edit reaches a phone holding the older copy');
}

// 3. A write that slipped past the stamp is caught by the content hash.
{
    const t0 = S.readMacSyncSet(true).app_schedule.modifiedAt;
    store.app_schedule = { scheduleItems: [{ id: 'sneaky' }] };
    const after = S.readMacSyncSet(true).app_schedule;
    const t1 = after.modifiedAt;
    assert(t1 >= t0, 'restamped no earlier');
    assert.deepStrictEqual(after.value, { scheduleItems: [{ id: 'sneaky' }] });
    assert.strictEqual(S.readMacSyncSet(true).app_schedule.modifiedAt, t1, 'an unchanged value keeps its stamp');
}

// 4. A newer phone change is asked for, applied, and stamped with the phone's time.
{
    const phoneAt = later(60e3);
    const plan = S.handleSyncManifest({ app_schedule: phoneAt });
    assert.deepStrictEqual(plan.want, ['app_schedule']);
    S.handleSyncValues({ app_schedule: { value: { scheduleItems: [{ id: 'from-phone' }] }, modifiedAt: phoneAt } });
    const set = S.readMacSyncSet(true);
    assert.deepStrictEqual(set.app_schedule.value, { scheduleItems: [{ id: 'from-phone' }] });
    assert.strictEqual(set.app_schedule.modifiedAt, phoneAt);
    assert.deepStrictEqual(S.handleSyncManifest({ app_schedule: phoneAt }).send, {}, 'then in sync');
    // An OLDER phone value is refused at apply time.
    S.handleSyncValues({ app_schedule: { value: { scheduleItems: [] }, modifiedAt: earlier(60e3) } });
    assert.deepStrictEqual(store.app_schedule, { scheduleItems: [{ id: 'from-phone' }] });
}

// 5. Deletes become tombstones both ways.
{
    store.app_notes = { notes: [] };
    S.stampChannelKey('app_notes');
    S.readMacSyncSet(true);
    delete store.app_notes;
    S.stampChannelKey('app_notes', { deleted: true });
    const set = S.readMacSyncSet(true);
    assert.strictEqual(set.app_notes.deleted, true);
    assert(!S.readMacSyncSet(false).app_notes, 'tombstones only when asked for');
    S.applyPhoneDelete('app_schedule', later(120e3));
    assert(!('app_schedule' in store));
    assert.strictEqual(S.readMacSyncSet(true).app_schedule.deleted, true);
}

// 7. A phone edit that names its base is MERGED with Mac changes made since
//    (2026-10-02): the Mac deleted one task and added one, the phone checked
//    one off — all three land, and the merge goes back down.
{
    store.app_tasks = { scheduleItems: [{ id: 'a', done: false }, { id: 'b', done: false }] };
    S.stampChannelKey('app_tasks');
    // The Mac sends its copy down: that version is now the shared base.
    const down = S.handleSyncManifest({ app_tasks: earlier(3600e3) }, [], {}).send.app_tasks;
    assert(down && down.value, 'sent down');
    const baseStamp = down.modifiedAt;
    // The Mac changes it afterwards.
    store.app_tasks = { scheduleItems: [{ id: 'a', done: false }, { id: 'c', done: false }] };
    S.stampChannelKey('app_tasks');
    // The phone, dirty since that base, is asked for its copy...
    const plan = S.handleSyncManifest({ app_tasks: later(1e3) }, ['app_tasks'], { app_tasks: baseStamp });
    assert.deepStrictEqual(plan.want, ['app_tasks']);
    // ...and its copy, based on the old version, is merged.
    S.handleSyncValues({ app_tasks: { value: { scheduleItems: [{ id: 'a', done: true }, { id: 'b', done: false }] }, modifiedAt: later(1e3), base: baseStamp } });
    assert.deepStrictEqual(store.app_tasks.scheduleItems.map(t => [t.id, t.done]), [['a', true], ['c', false]],
        'b stays deleted, c stays added, a is checked off');
    // A direct successor (the Mac unchanged since the base) is taken whole.
    const cur = S.readMacSyncSet(true).app_tasks.modifiedAt;
    S.handleSyncValues({ app_tasks: { value: { scheduleItems: [] }, modifiedAt: later(5e3), base: cur } });
    assert.deepStrictEqual(store.app_tasks, { scheduleItems: [] });
}

// 6. The stamps survive a restart.
{
    S.saveChannelStamps(true);
    const S2 = load(store);
    assert.strictEqual(S2.readMacSyncSet(true).app_notes.deleted, true);
    S2.saveChannelStamps(true); // settle the debounced write before cleanup
}

console.log = log;
fs.rmSync(dir, { recursive: true, force: true });
console.log('channel-stamps-test: ok');
