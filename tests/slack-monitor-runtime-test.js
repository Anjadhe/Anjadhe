'use strict';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { SlackMonitorRuntime } = require('../js/main/slack-monitor-runtime');
const { SlackMonitorIntake, STORE_KEY, INTAKE_LIMITS } = require('../js/main/slack-monitor-intake');
const { SlackReader } = require('../js/main/slack-reader');
const { MonitorError, planAnalysis } = require('../js/main/slack-monitor-policy');
const scope = { workspaceId: 'T123', userId: 'U123', conversationIds: ['D123'] };
const ts = n => `1770000000.${String(n).padStart(6, '0')}`;
const message = (n, extra = {}) => ({ kind: 'message', workspaceId: 'T123', channelId: 'D123', userId: 'U456',
    ts: ts(n), text: `Message ${n}`, editedTs: null, threadTs: null, hasReplies: false, attachmentsOmitted: false, ...extra });
const page = messages => ({ messages, complete: true, nextCursor: '' });
const config = { serverName: 'slack', scope, destination: 'local', consent: true };
const code = name => e => e.code === name;
const owner = id => ({ webContents: { id, isCrashed: () => false }, isDestroyed: () => false });

function fixture() {
    let value, time = 1770000000000, enabled = true, scheduled = 0, cleared = 0;
    const calls = [];
    const store = { get: key => { assert.equal(key, STORE_KEY); return value; }, set: (key, data) => { assert.equal(key, STORE_KEY); value = structuredClone(data); } };
    const background = new EventEmitter();
    Object.assign(background, { paused: false, quitting: false, owner: owner(1), windows: new Map() });
    background.windows.set(1, background.owner);
    let history = async () => page([]), replies = async () => page([]), reread = async () => ({ message: null, complete: true });
    const reader = { identity: async () => scope,
        history: async args => { calls.push({ kind: 'history', args }); return history(args); },
        replies: async args => { calls.push({ kind: 'thread', args }); return replies(args); },
        message: async args => { calls.push({ kind: 'recheck', args }); return reread(args); } };
    const servers = [{ name: 'slack', url: 'https://mcp.slack.com/mcp', auth: 'oauth', authStatus: 'connected', enabled: true }];
    const opts = { store, mcp: { listServers: () => servers, slackReader: () => reader }, background, now: () => time,
        enabled: () => enabled, setInterval: () => { scheduled++; return scheduled; }, clearInterval: () => { cleared++; } };
    const make = () => new SlackMonitorRuntime(opts);
    return { store, background, servers, calls, opts, make, runtime: make(),
        advance(ms = 60000) { time += ms; }, disable() { enabled = false; },
        setHistory(fn) { history = fn; }, setReplies(fn) { replies = fn; }, setReread(fn) { reread = fn; },
        get data() { return value; }, set data(v) { value = v; }, get time() { return time; },
        get scheduled() { return scheduled; }, get cleared() { return cleared; } };
}

async function threads() {
    let f = fixture(), intake = f.runtime.intake;
    f.runtime.start();
    await intake.configure(config);
    f.advance();
    f.setHistory(async () => page([message(1, { hasReplies: true })]));
    await intake.tick();
    assert.equal(f.data.threads[0].through, ts(1));
    f.advance();
    f.setReplies(async () => ({ messages: [message(1, { hasReplies: true, threadTs: ts(1) }), message(2, { threadTs: ts(1) })], nextCursor: 'next', complete: false }));
    await intake.tick();
    assert.equal(f.calls.at(-1).kind, 'thread', 'newly discovered thread gets a slot after history');
    assert.equal(f.data.threads[0].window.cursor, 'next');
    assert.equal(f.data.records[0].message.threadTs, ts(1), 'thread metadata can change without changing message identity');
    const threadUpper = f.data.threads[0].window.latest;
    f.runtime.shutdown();
    const resumed = f.make(); resumed.start(); intake = resumed.intake;
    f.advance();
    f.setReplies(async () => page([message(3, { threadTs: ts(1) })]));
    await intake.readThread('D123', ts(1));
    assert.equal(f.calls.at(-1).args.cursor, 'next');
    assert.equal(f.calls.at(-1).args.latest, threadUpper);
    assert.equal(f.data.threads[0].through, threadUpper);
    assert.equal(f.data.threads[0].window, null);
    assert.equal(intake.pending().messages.length, 3);
    assert.equal(planAnalysis(intake.pending()).messageIds.length, 3, 'root and replies form one bounded analysis window');

    // A delivered reply is rechecked with replies, never channel history.
    const pending = intake.pending(), ids = planAnalysis(pending).messageIds;
    intake.acknowledge({ revision: pending.revision, messageIds: ids, resultRef: 'matter:1' });
    intake.acknowledge({ revision: pending.revision, messageIds: ids, resultRef: 'matter:1', delivered: true });
    f.advance();
    f.setReread(async args => { assert.equal(args.threadTs, ts(1)); return { message: message(2, { threadTs: ts(1), editedTs: ts(30), text: 'Resolved' }), complete: true }; });
    await intake.revalidate('D123', ts(2));
    assert.equal(f.data.invalidations[0].id, `T123:D123:${ts(2)}:original`);
    assert.equal(intake.pending().messages[0].text, 'Resolved');
    f.advance(5 * 60000);
    f.setReplies(async () => { throw new MonitorError('source_unavailable', 'gone'); });
    assert.equal((await intake.readThread('D123', ts(1))).state, 'source_unavailable');
    assert.equal(f.data.threads.length, 0);
    assert.equal(f.data.records.length, 0);
    assert.equal(f.data.invalidations.length, 3, 'unavailable thread invalidates evidence without fabricating a resolution');
    resumed.shutdown();

    // A root can acquire its first reply long after it left channel history.
    f = fixture(); f.runtime.start(); intake = f.runtime.intake;
    await intake.configure(config); f.advance();
    f.setHistory(async () => page([message(1)]));
    await intake.tick();
    assert.equal(f.data.threads.length, 0);
    f.advance(INTAKE_LIMITS.recheckIntervalMs);
    f.setReread(async () => ({ message: message(1, { hasReplies: true, threadTs: ts(1) }), complete: true }));
    await intake.tick();
    assert.equal(f.calls.at(-1).kind, 'recheck');
    assert.equal(f.data.threads.length, 1);
    f.advance(); await intake.tick();
    f.advance(); await intake.tick();
    assert.equal(f.calls.at(-1).kind, 'thread', 'continued history does not starve replies');
    assert.equal(intake.status().coverageComplete, false);

    // Widening/reviewing consent must retain the original start for unchanged channels.
    await intake.configure(config);
    assert.equal(f.data.channels[0].startedAt, ts(0));
    f.advance();
    f.setHistory(async () => page([message(10, { threadTs: '1769990000.000001' })]));
    await intake.readOne();
    assert.equal(f.data.threads.find(t => t.ts === '1769990000.000001').through, ts(0));
    await intake.configure({ ...config, scope: { ...scope, conversationIds: ['C999'] } });
    assert.equal(f.data.threads.length, 0, 'removing a conversation removes its watches');
    f.runtime.shutdown();

    // Independent cursor windows: expiry in a thread cannot reset history progress.
    f = fixture(); f.runtime.start(); intake = f.runtime.intake;
    await intake.configure(config); f.advance();
    f.setHistory(async () => ({ messages: [message(1, { hasReplies: true })], nextCursor: 'history-page', complete: false }));
    await intake.readOne(); f.advance();
    f.setReplies(async () => ({ messages: [message(2, { threadTs: ts(1) })], nextCursor: 'thread-page', complete: false }));
    await intake.readThread('D123', ts(1)); f.advance();
    f.setReplies(async () => { throw new MonitorError('invalid_cursor', 'expired'); });
    await intake.readThread('D123', ts(1));
    assert.equal(f.data.threads[0].window.cursor, '');
    assert.equal(f.data.channels[0].window.cursor, 'history-page');
    f.runtime.shutdown();

    // Tracking limits are explicit. Excess threads cannot cause unbounded storage.
    f = fixture(); f.runtime.start(); intake = f.runtime.intake;
    await intake.configure(config);
    for (let batch = 0; batch < 8; batch++) {
        f.advance();
        f.setHistory(async () => page(Array.from({ length: 15 }, (_, n) => message(batch * 15 + n, { hasReplies: true }))));
        await intake.readOne();
    }
    assert.equal(f.data.threads.length, INTAKE_LIMITS.threads);
    assert.equal(intake.status().threadLimitReached, true);
    assert.ok(intake.status().coverageReasons.includes('thread_limit'));
    f.runtime.shutdown();
}

async function lifecycle() {
    let f = fixture();
    const gated = new SlackMonitorRuntime({ ...f.opts, enabled: undefined });
    gated.start(); await gated.intake.configure(config); await gated.pump();
    assert.equal(f.calls.length, 0, 'shipping release gate cannot be bypassed by stored consent');
    assert.equal(gated.status().available, false); gated.shutdown();

    f = fixture(); const runtime = f.runtime;
    runtime.start(); runtime.start();
    assert.equal(f.scheduled, 1); assert.equal(f.background.listenerCount('changed'), 1);
    await runtime.pump(); assert.equal(f.calls.length, 0, 'connection alone grants no observation consent');
    await runtime.intake.configure(config);
    f.setHistory(async () => page([message(0)]));
    await runtime.pump(); assert.equal(f.calls.length, 1);
    await runtime.pump(); assert.equal(f.calls.length, 1, 'timer frequency cannot bypass persisted cadence');
    runtime.shutdown(); assert.equal(f.cleared, 1); assert.equal(f.background.listenerCount('changed'), 0);
    f.advance();
    const restarted = f.make(); restarted.start(); await restarted.pump();
    assert.equal(f.data.records.length, 1, 'restart reuses consent and deduplicates messages');
    restarted.shutdown();

    for (const change of ['pause', 'sleep', 'owner', 'quit', 'crash', 'disconnect', 'disable']) {
        f = fixture(); const r = f.runtime; r.start(); await r.intake.configure(config);
        let finish;
        f.setHistory(() => new Promise(resolve => { finish = resolve; }));
        const reading = r.pump();
        await r.pump(); assert.equal(f.calls.length, 1, 'one network read across overlapping ticks');
        if (change === 'pause') { f.background.paused = true; f.background.emit('changed'); f.background.paused = false; f.background.emit('changed'); }
        if (change === 'sleep') { r.suspend(); r.resume(); }
        if (change === 'owner') { f.background.owner = owner(2); f.background.windows.set(2, f.background.owner); f.background.emit('changed'); }
        if (change === 'quit') { f.background.quitting = true; f.background.emit('changed'); }
        if (change === 'crash') { f.background.owner.webContents.isCrashed = () => true; f.background.emit('changed'); }
        if (change === 'disconnect') { f.servers[0].authStatus = 'disconnected'; r.connectionsChanged(); }
        if (change === 'disable') { f.servers[0].enabled = false; r.connectionsChanged(); }
        assert.equal(f.calls[0].args.signal.aborted, true, change);
        finish(page([message(0)])); await reading;
        assert.equal(f.data.records.length, 0, `late ${change} result is discarded`);
        if (change === 'disconnect' || change === 'disable') assert.equal(f.data.config, null);
        r.shutdown();
    }

    f = fixture(); f.runtime.start(); await f.runtime.intake.configure(config);
    let finish;
    f.setHistory(() => new Promise(resolve => { finish = resolve; }));
    const read = f.runtime.pump();
    f.runtime.connectionsChanged(); // OAuth token rotation: connection still valid
    assert.equal(f.calls[0].args.signal.aborted, false);
    finish(page([message(0)])); await read;
    assert.equal(f.data.records.length, 1);
    f.runtime.suspend(); f.advance(); await f.runtime.pump(); assert.equal(f.calls.length, 1);
    f.runtime.shutdown();

    for (const failure of ['account_changed', 'needs_sign_in']) {
        f = fixture(); f.runtime.start(); await f.runtime.intake.configure(config);
        f.setHistory(async () => { throw new MonitorError(failure, 'do not reconnect automatically'); });
        await f.runtime.pump();
        if (failure === 'account_changed') assert.equal(f.data.config, null);
        else assert.equal(f.data.paused, true);
        f.advance(3600000); await f.runtime.pump(); assert.equal(f.calls.length, 1);
        f.runtime.shutdown();
    }

    f = fixture(); f.data = { version: 1 }; f.runtime.start(); await f.runtime.pump();
    assert.equal(f.runtime.outcome, 'store_unavailable'); assert.equal(f.calls.length, 0);
    f.runtime.shutdown();
}

async function replyAdapter() {
    let replyArgs, missing = false;
    const reader = new SlackReader({ accessToken: async () => 'fixture', fetch: async (url, options) => {
        if (url.endsWith('auth.test')) return Response.json({ ok: true, team_id: 'T123', user_id: 'U123' });
        assert.ok(url.endsWith('conversations.replies'));
        replyArgs = Object.fromEntries(new URLSearchParams(options.body));
        if (missing) return Response.json({ ok: false, error: 'thread_not_found' });
        return Response.json({ ok: true, messages: [
            { type: 'message', user: 'U456', text: 'OLD_PARENT_CANARY', ts: ts(1), thread_ts: ts(1) },
            { type: 'message', user: 'U456', text: 'Resolved', ts: ts(2), thread_ts: ts(1) }
        ] });
    } });
    const result = await reader.message({ scope, channelId: 'D123', ts: ts(2), threadTs: ts(1) });
    assert.equal(result.message.text, 'Resolved'); assert.equal(result.complete, true);
    assert.equal(replyArgs.ts, ts(1)); assert.equal(replyArgs.oldest, ts(2));
    assert.ok(!JSON.stringify(result).includes('OLD_PARENT_CANARY'));
    missing = true;
    assert.deepEqual(await reader.message({ scope, channelId: 'D123', ts: ts(2), threadTs: ts(1) }), { message: null, complete: true });
    reader.stop();
}

(async () => {
    await threads(); await lifecycle(); await replyAdapter();
    console.log('Slack monitor runtime: fair bounded reconciliation, restart, lifecycle and release gate passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
