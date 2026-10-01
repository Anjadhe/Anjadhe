// Streaming the assistant's answer to the phone
// (js/agent/mobile-channel.js `_streamTo`, 2026-09-21 — docs/MOBILE_NATIVE.md
// "M4", where `chat-delta` was named).
//
// The phone used to wait for the whole reply. It now watches it arrive, and
// the forwarding has to be a POLL over `AgentService._streamingState` because
// the `onChunk` callback is dropped for any conversation that is not the
// Mac's ACTIVE one — and a mobile conversation is never made active. That is
// the CLIBridge precedent, and it brings two traps this pins:
//
//   1. the buffer RESETS to empty at the start of every tool iteration, so a
//      shrink means "start again", never "text was deleted";
//   2. deltas are INCREMENTAL and numbered, because a cumulative push would
//      re-send the whole answer every tick and cross the channel's gzip
//      threshold mid-stream.
//
// And the contract that makes all of it safe: a delta is pure UX. The
// finished answer still goes out as `chat-reply` and still rides the synced
// conversation blob, so a phone that misses every delta loses nothing.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const source = fs.readFileSync(path.join(__dirname, '../js/agent/mobile-channel.js'), 'utf8');
const dom = new JSDOM('<body></body>', { url: 'https://local.test', runScripts: 'outside-only' });
const w = dom.window;

const sent = [];
w.electronMobileChat = {
    onMessage() { /* init is never called here */ },
    sendResult: async () => ({ ok: true }),
    sendDelta: (d) => sent.push(d),
};
const streaming = new Map();
w.AgentService = { _streamingState: streaming };

w.eval(source + '\nwindow.subject = MobileChannel;');
const chan = w.subject;

let failures = 0;
async function check(name, fn) {
    try { await fn(); console.log('  ok   ' + name); }
    catch (e) { failures++; console.log('  FAIL ' + name + ' — ' + e.message); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    // A fast tick so the test does not take a second per assertion. The
    // production cadence (300 ms) is a cost knob, not a correctness one.
    chan.STREAM_TICK_MS = 15;

    console.log('\nStreaming to the phone');

    const st = { content: '' };
    streaming.set('c1', st);
    const stop = chan._streamTo('c1');

    st.content = 'Hello';                       // below STREAM_MIN_CHARS
    await sleep(40);
    await check('a couple of characters do not earn a frame of their own', () => {
        assert.equal(sent.length, 0);
    });

    st.content = 'Hello, here is a proper sentence of output.';
    await sleep(40);
    await check('a worthwhile amount of new text is pushed', () => {
        assert.equal(sent.length, 1);
        assert.equal(sent[0].text, 'Hello, here is a proper sentence of output.');
        assert.equal(sent[0].convId, 'c1');
        assert.equal(sent[0].seq, 1);
    });

    st.content += ' And a second sentence follows it here.';
    await sleep(40);
    await check('the next push is INCREMENTAL, not the whole answer again', () => {
        assert.equal(sent.length, 2);
        assert.equal(sent[1].text, ' And a second sentence follows it here.');
        assert.equal(sent[1].seq, 2, 'and numbered, so the phone can spot a gap');
    });

    // The tool-iteration reset: agent-service empties the buffer between
    // iterations. Slicing from the old offset here would send garbage.
    st.content = '';
    await sleep(40);
    st.content = 'Right, I checked the calendar and you are free.';
    await sleep(40);
    await check('a buffer reset starts again rather than slicing from a stale offset', () => {
        const last = sent[sent.length - 1];
        assert.equal(last.text, 'Right, I checked the calendar and you are free.');
        assert.equal(sent.length, 3);
    });

    await check('nothing is re-sent while the buffer is unchanged', async () => {
        const before = sent.length;
        await sleep(40);
        assert.equal(sent.length, before);
    });

    // Stopping flushes whatever is left, however small — the run is over, so
    // the min-chars floor no longer applies.
    st.content += ' Ok.';
    stop();
    await check('stopping flushes the tail even below the minimum', () => {
        assert.equal(sent[sent.length - 1].text, ' Ok.');
    });

    await check('and stops the timer', async () => {
        const before = sent.length;
        st.content += ' more text that should never be pushed at all';
        await sleep(50);
        assert.equal(sent.length, before);
    });

    console.log('\nDegrading honestly');

    await check('a conversation with no stream state pushes nothing', async () => {
        const before = sent.length;
        const s2 = chan._streamTo('nope');
        await sleep(40);
        s2();
        assert.equal(sent.length, before);
    });

    await check('an older Mac build with no sendDelta bridge is a no-op, not a crash', () => {
        const saved = w.electronMobileChat.sendDelta;
        delete w.electronMobileChat.sendDelta;
        const s3 = chan._streamTo('c1');
        assert.equal(typeof s3, 'function');
        s3();
        w.electronMobileChat.sendDelta = saved;
    });

    await sleep(60);
    console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
    process.exit(failures ? 1 : 0);
})();
