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
        assert.deepEqual(runs[0], { script: SEND_SCRIPT, args: ['+14255550199', body] });
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
    notify.show('Standup', '9:00 AM', { kind: 'reminder' });
    assert.equal(banners.length, 1);
    assert.deepEqual(telegram, [['Standup', '9:00 AM', 'reminder']]);
    notify.show('Local', 'Only here', { telegram: false });
    assert.equal(banners.length, 2);
    assert.equal(telegram.length, 1);
    Notification.permission = 'denied';
    notify.show('Remote', 'Still delivered', { kind: 'task' });
    assert.equal(banners.length, 2);
    assert.equal(telegram.length, 2);
    assert.equal(texts.length, 0, 'no notification ever reaches Messages');

    console.log('imessage-bridge: all assertions passed');
})().catch(e => { console.error(e); process.exit(1); });
