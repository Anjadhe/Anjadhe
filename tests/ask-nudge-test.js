// The unanswered-ask nudge (js/agent/agent-ui.js `_nudgeIfUnanswered`,
// 2026-09-21).
//
// A permission ask used to notify nobody: it painted a card and waited,
// which is right while you are at your Mac and wrong the moment you are
// not. It is also what makes the phone's "Needs you" reach you at all —
// there is no push service by design, so the Mac's existing forward lanes
// (Telegram, iMessage) are the reach.
//
// This is a NEW WAY FOR A CHAT'S WORDS TO LEAVE THE MAC, so the checks
// that matter most are the ones about what it must not say.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '../js/agent/agent-ui.js'), 'utf8');
// Lift just the object literal's nudge members — the file is a 300 KB UI
// module that cannot be loaded headlessly, and the rule under test is
// self-contained.
const PrivateChat = require('../js/agent/private-chat');

let failures = 0;
const check = (name, fn) => {
    try { fn(); console.log('  ok   ' + name); }
    catch (e) { failures++; console.log('  FAIL ' + name + ' — ' + e.message); }
};

// Rebuild the subject in a controlled scope, from the real source, so the
// test cannot drift from the shipped text.
function makeSubject({ conversations, notify }) {
    const start = src.indexOf('    _nudgeIfUnanswered(ask) {');
    const end = src.indexOf('    _lastAskNudgeAt: 0,') + '    _lastAskNudgeAt: 0,'.length;
    assert.ok(start > 0 && end > start, 'the nudge members are still where the test expects');
    const body = src.slice(start, end);
    const factory = new Function('Notify', 'AgentService', 'PrivateChat', 'setTimeout',
        `return { ${body} };`);
    const timers = [];
    const subject = factory(notify, { conversations }, PrivateChat, (fn) => timers.push(fn));
    subject._fire = () => { const t = timers.slice(); timers.length = 0; t.forEach(fn => fn()); };
    return subject;
}

const sent = [];
const Notify = { show: (title, body, opts) => sent.push({ title, body, kind: opts && opts.kind }) };
const conversations = [
    { id: 'open', title: 'Trip planning' },
    { id: 'secret', title: 'Private', private: true },
];

console.log('an ordinary ask');
{
    sent.length = 0;
    const s = makeSubject({ conversations, notify: Notify });
    const ask = { convId: 'open', toolName: 'send_email', summary: 'May I send this to Sam?', settled: false };
    s._nudgeIfUnanswered(ask);
    check('nothing is sent before the wait is up', () => assert.equal(sent.length, 0));
    s._fire();
    check('then one notification goes out', () => assert.equal(sent.length, 1));
    check('it carries the ask and says where to answer', () => {
        assert.match(sent[0].body, /May I send this to Sam\?/);
        assert.match(sent[0].body, /on your phone/i);
        assert.equal(sent[0].kind, 'approval');
    });
}

console.log('\nan ask the user answered in time');
{
    sent.length = 0;
    const s = makeSubject({ conversations, notify: Notify });
    const ask = { convId: 'open', toolName: 'send_email', summary: 'May I?', settled: false };
    s._nudgeIfUnanswered(ask);
    ask.settled = true;                 // answered at the Mac
    s._fire();
    check('a settled ask never nudges', () => assert.equal(sent.length, 0));
}

console.log('\na private chat');
{
    sent.length = 0;
    const s = makeSubject({ conversations, notify: Notify });
    s._nudgeIfUnanswered({ convId: 'secret', toolName: 'send_email', summary: 'SECRET SUMMARY', settled: false });
    s._fire();
    check('it still says work is stuck', () => assert.equal(sent.length, 1));
    check('but carries none of the chat — no summary, no tool name', () => {
        assert.ok(!sent[0].body.includes('SECRET SUMMARY'), 'the summary must not leave the Mac');
        assert.ok(!sent[0].body.includes('send_email'), 'nor the tool it wanted');
        assert.ok(!sent[0].body.includes('send email'));
        assert.match(sent[0].body, /A private chat is waiting/);
    });
}

console.log('\na chat we cannot find');
{
    sent.length = 0;
    const s = makeSubject({ conversations: null, notify: Notify });  // lookup throws
    s._nudgeIfUnanswered({ convId: 'gone', toolName: 'send_email', summary: 'SECRET SUMMARY', settled: false });
    s._fire();
    check('unsure is treated as private', () => {
        assert.equal(sent.length, 1);
        assert.ok(!sent[0].body.includes('SECRET SUMMARY'));
    });
}

console.log('\na turn that queues several asks');
{
    sent.length = 0;
    const s = makeSubject({ conversations, notify: Notify });
    for (let i = 0; i < 5; i++) {
        s._nudgeIfUnanswered({ convId: 'open', toolName: 'read_url', summary: 'Ask ' + i, settled: false });
    }
    s._fire();
    check('only one notification goes out, not five', () => assert.equal(sent.length, 1));
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
