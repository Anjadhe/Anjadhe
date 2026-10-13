/** iMessage explicit-send bridge and retired notification lane; no real sends. */
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const { createIMessageBridge, normalizeHandle, explainError, SEND_SCRIPT } = require('../js/main/imessage-bridge');

(async () => {
    const store = new Map([['imessageNotify', true], ['imessageHandle', '+14255550100']]);
    const settingsStore = {
        get: (k, d) => store.has(k) ? store.get(k) : d,
        set: (k, v) => store.set(k, v),
        delete: k => store.delete(k),
    };
    const runs = [];
    let nextResult = { ok: true };
    const bridge = createIMessageBridge({ settingsStore, runScript: async (script, args) => {
        runs.push({ script, args }); return nextResult;
    } });
    assert.equal(store.has('imessageNotify'), false, 'retires existing forwarding opt-in');
    assert.equal(bridge.status().handle, '+14255550100', 'preserves own number for explicit sends');
    assert.equal(runs.length, 0, 'upgrade never sends');
    for (const method of ['notifyToLinked', 'setNotify', 'sendTest', 'send']) {
        assert.equal(bridge[method], undefined, `${method} is no longer exposed`);
    }

    assert.equal(normalizeHandle(' +1 (425) 555-0100 '), '+14255550100');
    assert.equal(normalizeHandle('Ram@Example.com'), 'ram@example.com');
    assert.ok(bridge.setHandle('not a handle').error);
    assert.equal(bridge.status().handle, '+14255550100', 'invalid save preserves own number');
    assert.ok(bridge.setHandle('Ram@Example.com').ok);
    assert.equal(bridge.status().handle, 'ram@example.com');
    assert.ok(bridge.setHandle('').ok);
    assert.equal(bridge.status().handle, '');

    assert.match(explainError('Not authorized to send Apple events (-1743)'), /Privacy & Security › Automation/);
    assert.match(explainError('Can’t get account whose service type = iMessage'), /not signed in/);
    assert.match(explainError("Can't get participant"), /could not find that handle/);
    const body = 'running late "quoted"\nsecond line';
    const result = await bridge.sendTo(' +1 (425) 555-0199 ', body);
    if (process.platform === 'darwin') {
        assert.ok(result.ok);
        assert.equal(result.handle, '+14255550199');
        assert.deepEqual(runs[0], { script: SEND_SCRIPT, args: ['+14255550199', body, 'iMessage'] });
        assert.equal(result.status, 'unverified', 'no reader: never claims delivery');
        assert.ok(!runs[0].script.includes(body), 'text stays out of script source');
        assert.ok((await bridge.sendTo('not a handle', 'hi')).error);
        assert.ok((await bridge.sendTo('+14255550199', '   ')).error);
        assert.equal(runs.length, 1, 'invalid recipients and empty messages never execute');
        nextResult = { error: "Can't get participant" };
        assert.match((await bridge.sendTo('+14255550199', 'x')).error, /could not find that handle/);
    } else {
        assert.match(result.error, /only available on a Mac/);
        assert.equal(runs.length, 0);
    }

    // Route, then check (2026-10-09): osascript's exit 0 is not delivery.
    if (process.platform === 'darwin') {
        // A fake chat.db: `services` is where each handle last worked;
        // `outcome(service)` is what Messages records for our new row.
        function harness({ services = {}, outcome, readable = true }) {
            let rowid = 100;
            const sends = [];
            const rows = [];
            const reader = {
                serviceFor: h => ({ ok: true, service: services[h] || '' }),
                lastRowid: () => readable ? { ok: true, rowid } : { ok: false, reason: 'fda' },
                outgoingAfter: (after) => ({ ok: true, rows: rows.filter(r => r.rowid > after) }),
            };
            const b = createIMessageBridge({
                settingsStore, reader, sleep: async () => {}, verifyMs: 3000,
                runScript: async (_script, args) => {
                    sends.push(args[2]);
                    const o = outcome(args[2]);
                    if (o) rows.push({ rowid: ++rowid, service: args[2], error: 0, sent: false, delivered: false, ...o });
                    return { ok: true };
                },
            });
            return { b, sends };
        }

        // An SMS-only contact goes out on the SMS account from the start.
        let h = harness({ services: { '+14255550111': 'SMS' }, outcome: () => ({ sent: true }) });
        let r = await h.b.sendTo('+1 425 555 0111', 'hi');
        assert.deepEqual(h.sends, ['SMS'], 'routed to SMS by history');
        assert.equal(r.ok, true); assert.equal(r.status, 'sent'); assert.equal(r.service, 'SMS');

        // RCS history routes the same way.
        h = harness({ services: { '+14255550111': 'RCS' }, outcome: () => ({ sent: true }) });
        await h.b.sendTo('+14255550111', 'hi');
        assert.deepEqual(h.sends, ['SMS']);

        // The bug: no history, iMessage fails → one SMS retry, said so.
        h = harness({ outcome: s => s === 'iMessage' ? { error: 22 } : { sent: true } });
        r = await h.b.sendTo('+14255550122', 'hi');
        assert.deepEqual(h.sends, ['iMessage', 'SMS'], 'failed iMessage retried as SMS');
        assert.equal(r.ok, true); assert.equal(r.service, 'SMS');
        assert.match(r.note, /went as a text message/);

        // Both fail → an ERROR, never a receipt.
        h = harness({ outcome: () => ({ error: 22 }) });
        r = await h.b.sendTo('+14255550122', 'hi');
        assert.ok(r.error && !r.ok, 'failure is an error');
        assert.match(r.error, /Not Delivered/);

        // An email never falls back to SMS.
        h = harness({ outcome: () => ({ error: 22 }) });
        r = await h.b.sendTo('pat@example.com', 'hi');
        assert.deepEqual(h.sends, ['iMessage']);
        assert.match(r.error, /not reachable on iMessage/);

        // Delivered iMessage; a row that never appears is "unconfirmed".
        h = harness({ outcome: () => ({ sent: true, delivered: true }) });
        assert.equal((await h.b.sendTo('+14255550133', 'hi')).status, 'delivered');
        h = harness({ outcome: () => null });
        assert.equal((await h.b.sendTo('+14255550133', 'hi')).status, 'unconfirmed');
        h = harness({ outcome: () => ({ sent: true }) });
        assert.equal((await h.b.sendTo('+14255550133', 'hi')).status, 'sent', 'iMessage sent, not yet delivered');

        // Unreadable chat.db: unverified, never delivered.
        h = harness({ readable: false, outcome: () => ({ error: 22 }) });
        assert.equal((await h.b.sendTo('+14255550133', 'hi')).status, 'unverified');

        // The SMS account missing is its own sentence.
        assert.match(explainError("Can’t get account 1 whose service type = SMS"), /Text Message Forwarding/);
    }

    // An old iMessage-enabled renderer status must never forward or keep
    // the reminder scan running; Telegram and local delivery still work.
    const texts = [], telegram = [], banners = [];
    class Notification {
        static permission = 'granted';
        constructor(title, options) { banners.push({ title, ...options }); }
    }
    const context = vm.createContext({ Notification, window: {
        electronIMessage: {
            getStatus: async () => ({ notify: true, handle: '+14255550100' }),
            notify: async (...args) => texts.push(args),
        },
        electronTelegram: {
            getStatus: async () => ({ enabled: false }),
            notify: async (...args) => telegram.push(args),
        },
    } });
    vm.runInContext(fs.readFileSync(require.resolve('../js/core/notify.js'), 'utf8') + '\nthis.Notify = Notify;', context);
    const notify = context.Notify;
    notify.init();
    await notify.refreshTelegram();
    assert.equal(notify.forwardActive(), false, 'old iMessage opt-in cannot keep scan active');
    await notify.refreshTelegram({ enabled: true, notify: true, chat: { id: 1 } });
    assert.equal(notify.forwardActive(), true, 'Telegram keeps scan active');
    // Since 2026-10-08 (PhoneReach) a plain notice stays on the Mac: only
    // one marked `phone` reaches Telegram, through PhoneReach, never directly.
    notify.show('Standup', '9:00 AM', { kind: 'reminder' });
    assert.equal(banners.length, 1);
    assert.deepEqual(telegram, [], 'a plain notice is not forwarded');
    const reached = [];
    context.PhoneReach = { reach: async (facts) => { reached.push(facts); } };
    notify.show('Standup', '9:00 AM', { kind: 'reminder', phone: { type: 'commitment', title: 'Standup', when: '9:00 AM' } });
    assert.equal(banners.length, 2);
    assert.equal(reached.length, 1, 'a phone-marked notice goes through PhoneReach');
    assert.deepEqual(telegram, [], 'never straight to the bridge');
    assert.equal(texts.length, 0, 'no notification ever reaches Messages');

    console.log('imessage-bridge: all assertions passed');
})().catch(e => { console.error(e); process.exit(1); });
