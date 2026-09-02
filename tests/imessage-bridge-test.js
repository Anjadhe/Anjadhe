/**
 * iMessage bridge test (js/main/imessage-bridge.js), headless.
 *
 * Pins the gate and the plumbing with an injected script runner (osascript
 * is never touched):
 *   - forwarding is OFF by default and needs BOTH the toggle and a handle;
 *   - the handle is validated and normalised (phone loses punctuation,
 *     email lowercases); clearing it turns forwarding off;
 *   - text and handle reach the script as argv, never spliced into source;
 *   - the message wears the shared "Anjadhe · <Kind>" header;
 *   - osascript errors map to one plain sentence (TCC, not signed in…)
 *     and land in status().lastError; a good send clears it.
 *
 * Run: node tests/imessage-bridge-test.js
 */
const assert = require('assert');
const { createIMessageBridge, normalizeHandle, explainError, SEND_SCRIPT } = require('../js/main/imessage-bridge');

const store = new Map();
const settingsStore = {
    get: (k, d) => (store.has(k) ? store.get(k) : d),
    set: (k, v) => store.set(k, v),
    delete: (k) => store.delete(k),
};
const runs = [];
let nextResult = { ok: true };
const runScript = async (script, args) => { runs.push({ script, args }); return nextResult; };

(async () => {
    const bridge = createIMessageBridge({ settingsStore, runScript });
    const darwin = process.platform === 'darwin';

    // --- default posture --------------------------------------------------
    let st = bridge.status();
    assert.strictEqual(st.notify, false, 'OFF by default');
    assert.strictEqual(st.handle, '', 'no handle by default');
    let r = await bridge.notifyToLinked('Standup', '9:00 AM', 'reminder');
    assert.ok(r.skipped, 'nothing forwards by default');
    assert.strictEqual(runs.length, 0);

    // --- handle validation ------------------------------------------------
    assert.strictEqual(normalizeHandle(' +1 (425) 555-0100 '), '+14255550100');
    assert.strictEqual(normalizeHandle('Ram@Example.com'), 'ram@example.com');
    r = bridge.setHandle('not a handle');
    assert.ok(r.error, 'garbage is rejected');
    assert.strictEqual(bridge.status().handle, '', 'rejected handle not stored');
    r = bridge.setHandle('+1 (425) 555-0100');
    assert.ok(r.ok);
    assert.strictEqual(bridge.status().handle, '+14255550100', 'stored normalised');

    // Handle alone is not enough — the toggle is the consent.
    r = await bridge.notifyToLinked('Standup', '9:00 AM', 'reminder');
    assert.ok(r.skipped, 'handle without toggle → no forward');

    bridge.setNotify(true);
    r = await bridge.notifyToLinked('Standup', '9:00 AM', 'reminder');
    if (darwin) {
        assert.strictEqual(r.ok, true);
        assert.strictEqual(runs.length, 1, 'one script run');
        assert.strictEqual(runs[0].script, SEND_SCRIPT, 'the fixed send script');
        assert.deepStrictEqual(runs[0].args, ['+14255550100', 'Anjadhe · Reminder\nStandup\n9:00 AM'],
            'handle and text as argv, kind header on the text');
        assert.ok(!runs[0].script.includes('Standup'), 'text never spliced into the script source');
    } else {
        assert.ok(r.error, 'non-Mac: honest error');
    }

    // --- error mapping ------------------------------------------------------
    assert.match(explainError('execution error: Not authorized to send Apple events to Messages. (-1743)'), /Privacy & Security › Automation/);
    assert.match(explainError("execution error: Messages got an error: Can’t get account 1 whose service type = iMessage. (-1728)"), /not signed in/);
    assert.match(explainError("execution error: Messages got an error: Can’t get participant \"x\" of account id \"y\". (-1728)"), /could not find that handle/);
    if (darwin) {
        nextResult = { error: 'execution error: Not authorized to send Apple events to Messages. (-1743)' };
        r = await bridge.notifyToLinked('Standup', '9:00 AM', 'reminder');
        assert.ok(r.error, 'failed send reports');
        assert.match(bridge.status().lastError, /Automation/, 'lastError carries the plain sentence');
        nextResult = { ok: true };
        r = await bridge.sendTest();
        assert.strictEqual(r.ok, true);
        assert.strictEqual(bridge.status().lastError, null, 'a good send clears lastError');
        assert.match(runs[runs.length - 1].args[1], /^Anjadhe · Notification\nTest from Anjadhe/, 'test message wears the header');
    }

    // --- empty notification -------------------------------------------------
    const before = runs.length;
    r = await bridge.notifyToLinked('', '   ', 'email');
    assert.ok(r.skipped, 'empty notification never sends');
    assert.strictEqual(runs.length, before);

    // --- clearing the handle turns forwarding off ---------------------------
    r = bridge.setHandle('');
    assert.ok(r.ok);
    st = bridge.status();
    assert.strictEqual(st.handle, '');
    assert.strictEqual(st.notify, false, 'no handle → toggle off');

    console.log('imessage-bridge: all assertions passed');
})().catch((e) => { console.error(e); process.exit(1); });
