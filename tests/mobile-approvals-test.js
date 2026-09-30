// Approvals on the phone (docs/MOBILE_NATIVE.md "M5"): a phone turn's step
// that needs the user's OK is asked ON THE PHONE (MobileChannel), with the
// Mac card's own words and scopes; unanswered or orphaned asks decline; and
// operating this Mac's screen or apps is never offered to the phone.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const load = (f) => (0, eval)(fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/^const (\w+) =/m, 'globalThis.$1 ='));

const sent = [], done = [];
globalThis.window = { electronMobileChat: { sendAsk: (a) => sent.push(a), sendAskDone: (d) => done.push(d), sendResult: async () => {}, sendDelta() {} } };
globalThis.AgentUI = { _describeToolAction: (t, a) => `Send an email to <strong>${a.to}</strong> &amp; archive` };
load('js/agent/mobile-channel.js');

(async () => {
    // No live phone run → not ours to ask.
    assert.strictEqual(MobileChannel.wantsPermission('c1'), false);
    MobileChannel._running.add('c1');
    assert.strictEqual(MobileChannel.wantsPermission('c1'), true);

    // The ask is pushed with the Mac card's words, as plain text.
    const p = MobileChannel.askPermission('c1', 'send_email', { to: 'a@b.c' }, 'Goes out from your account', { onceOnly: false });
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].text, 'Send an email to **a@b.c** & archive');
    assert.strictEqual(sent[0].note, 'Goes out from your account');
    assert.deepStrictEqual(MobileChannel.pendingAsks().map(a => a.askId), [sent[0].askId]);

    // A stranger's answer id is ignored; the right one resolves with its scope.
    assert.strictEqual(MobileChannel._answerAsk({ askId: 'nope', approved: true }), false);
    assert.strictEqual(MobileChannel._answerAsk({ askId: sent[0].askId, approved: true, scope: 'session' }), true);
    assert.deepStrictEqual(await p, { approved: true, scope: 'session' });
    assert.deepStrictEqual(done.at(-1), { askId: sent[0].askId, approved: true });
    assert.strictEqual(MobileChannel.pendingAsks().length, 0);

    // A step that asks every time can only be approved once.
    const p2 = MobileChannel.askPermission('c1', 'mac_act', {}, '', { onceOnly: true });
    MobileChannel._answerAsk({ askId: sent[1].askId, approved: true, scope: 'always' });
    assert.deepStrictEqual(await p2, { approved: true, scope: 'once' });

    // The run ending declines whatever it still has open.
    const p3 = MobileChannel.askPermission('c1', 'delete_note', {}, '');
    MobileChannel._endRun('c1');
    assert.deepStrictEqual(await p3, { approved: false, scope: 'once' });
    assert.strictEqual(MobileChannel.wantsPermission('c1'), false);

    // Unanswered → declined after the timeout.
    MobileChannel._running.add('c2');
    MobileChannel.ASK_TIMEOUT_MS = 20;
    assert.deepStrictEqual(await MobileChannel.askPermission('c2', 'send_text', {}, ''), { approved: false, scope: 'once' });

    // AgentService never offers screen or Mac control to the phone.
    const src = fs.readFileSync(path.join(__dirname, '../js/agent/agent-service.js'), 'utf8');
    const m = src.match(/_phoneAsks\(name, convId\) \{([\s\S]*?)\n    \},/);
    assert(m, '_phoneAsks not found');
    const phoneAsks = new Function('name', 'convId', 'MobileChannel', m[1]);
    const mc = { wantsPermission: () => true };
    assert.strictEqual(phoneAsks('send_email', 'c1', mc), true);
    assert.strictEqual(phoneAsks('screen_act', 'c1', mc), false);
    assert.strictEqual(phoneAsks('mac_act', 'c1', mc), false);

    console.log('mobile-approvals-test: ok');
})().catch((e) => { console.error(e); process.exit(1); });
