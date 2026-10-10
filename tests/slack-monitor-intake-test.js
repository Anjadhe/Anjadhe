'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SlackReader, READ_LIMITS } = require('../js/main/slack-reader');
const { SlackMonitorIntake, STORE_KEY, INTAKE_LIMITS } = require('../js/main/slack-monitor-intake');
const { planAnalysis } = require('../js/main/slack-monitor-policy');
const scope = { workspaceId: 'T123', userId: 'U123', conversationIds: ['D123'] };
const baseTime = 1770000000000;
const ts = n => `1770000000.${String(n).padStart(6, '0')}`;
const raw = (n, extra = {}) => ({ type: 'message', ts: ts(n), user: 'U456', text: `Request ${n}`, ...extra });
const message = (n, extra = {}) => ({ kind: 'message', workspaceId: scope.workspaceId, channelId: 'D123',
    ts: ts(n), userId: 'U456', text: `Request ${n}`, editedTs: null, threadTs: null, attachmentsOmitted: false, hasReplies: false, ...extra });
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers });
const code = value => error => error.code === value;
const page = messages => ({ messages, complete: true, nextCursor: '', limited: false });

async function readerTests() {
    let calls = [], tokenCalls = [], response = () => json({ ok: true, messages: [raw(1)], has_more: false }),
        identity = { ok: true, team_id: 'T123', user_id: 'U123' }, connected = true;
    const reader = new SlackReader({ connected: () => connected,
        accessToken: async rejected => { tokenCalls.push(rejected); return rejected ? 'fresh-secret' : 'secret'; },
        fetch: async (url, options) => {
            const method = url.slice('https://slack.com/api/'.length);
            assert.ok(url.startsWith('https://slack.com/api/'));
            assert.equal(options.redirect, 'error');
            assert.equal(options.method, 'POST');
            assert.ok(['Bearer secret', 'Bearer fresh-secret'].includes(options.headers.Authorization));
            assert.ok(!options.body.includes('secret'));
            const params = Object.fromEntries(new URLSearchParams(options.body));
            calls.push({ method, params, signal: options.signal });
            return method === 'auth.test' ? json(identity) : response(method, options);
        }
    });
    const input = { scope, channelId: 'D123', oldest: ts(0), latest: ts(999999) };
    assert.deepEqual(await reader.identity(), { workspaceId: 'T123', userId: 'U123' });
    response = () => json({ ok: true, messages: [raw(1, { edited: { ts: ts(2) }, thread_ts: ts(0), files: [{ private: 'CANARY' }], arbitrary: 'CANARY' })], has_more: false });
    const result = await reader.history(input);
    assert.equal(result.messages[0].editedTs, ts(2));
    assert.equal(result.messages[0].threadTs, ts(0));
    assert.equal(result.messages[0].attachmentsOmitted, true);
    assert.ok(!JSON.stringify(result).includes('CANARY'));
    assert.deepEqual(calls.at(-1).params, { channel: 'D123', oldest: ts(0), latest: ts(999999), inclusive: 'true', limit: '15' });
    await reader.history({ ...input, limit: 999999 });
    assert.equal(calls.at(-1).params.limit, '15', 'callers cannot raise the page ceiling');
    const count = calls.length;
    await assert.rejects(reader.history({ ...input, channelId: 'C999' }), code('invalid_scope'));
    await assert.rejects(reader.history({ ...input, oldest: '0' }), code('invalid_window'));
    await assert.rejects(reader.history({ ...input, cursor: 'x'.repeat(2049) }), code('invalid_cursor'));
    assert.equal(calls.length, count, 'reject scope and unbounded inputs before OAuth or network');
    identity.team_id = 'T999';
    await assert.rejects(reader.history(input), code('account_changed'));
    assert.equal(calls.at(-1).method, 'auth.test', 'no message read under a switched account');
    identity = { ok: true, team_id: 'T123', user_id: 'U123', bot_id: 'B123' };
    await assert.rejects(reader.identity(), code('invalid_identity'));
    identity = { ok: true, team_id: 'T123', user_id: 'U123' };

    response = () => json({ ok: true, channels: [{ id: 'D123', is_im: true, user: 'U456', latest: { text: 'CANARY' } }], response_metadata: { next_cursor: 'page2' } });
    const list = await reader.conversations();
    assert.equal(list.conversations[0].peerId, 'U456');
    assert.equal(list.nextCursor, 'page2');
    assert.ok(!JSON.stringify(list).includes('CANARY'), 'picker never returns latest-message bodies');
    response = method => method === 'users.info'
        ? json({ ok: true, user: { id: 'U456', profile: { display_name: 'Alex', email: 'CANARY' } } })
        : json({ ok: true, channels: [{ id: 'D123', is_im: true, user: 'U456', latest: { text: 'CANARY' } }] });
    const named = await reader.conversations({ names: true });
    assert.equal(named.conversations[0].name, 'Alex');
    assert.ok(!JSON.stringify(named).includes('CANARY'), 'picker keeps only the requested display name');
    assert.deepEqual(calls.at(-1).params, { user: 'U456' });
    const namesCalls = calls.filter(c => c.method === 'users.info').length;
    await reader.conversations();
    assert.equal(calls.filter(c => c.method === 'users.info').length, namesCalls, 'names are only requested for the open picker');
    response = method => method === 'users.info' ? json({ ok: true, user: { id: 'U999', real_name: 'Wrong person' } })
        : json({ ok: true, channels: [{ id: 'D123', is_im: true, user: 'U456' }] });
    await assert.rejects(reader.conversations({ names: true }), code('invalid_response'));

    response = () => json({ ok: true, messages: [raw(1)], response_metadata: { next_cursor: 'next' }, has_more: true });
    assert.equal((await reader.history(input)).complete, false);
    await assert.rejects(reader.history({ ...input, cursor: 'next' }), code('invalid_cursor'));
    response = () => json({ ok: true, messages: [], has_more: true });
    await assert.rejects(reader.history(input), code('pagination_incomplete'));
    response = () => json({ ok: true, messages: [], is_limited: true });
    assert.equal((await reader.history(input)).complete, false);
    response = () => json({ ok: true, messages: Array.from({ length: 16 }, (_, i) => raw(i)) });
    await assert.rejects(reader.history(input), code('invalid_response'));
    response = () => json({ ok: true, messages: [raw(1, { ts: '1769999999.000000' })] });
    await assert.rejects(reader.history(input), code('invalid_response'));
    response = () => json({ ok: false, error: 'missing_scope', secret: 'CANARY' });
    await assert.rejects(reader.history(input), e => e.code === 'access_denied' && !e.message.includes('CANARY'));
    response = () => json({}, 429, { 'retry-after': '120' });
    await assert.rejects(reader.history(input), e => e.code === 'rate_limited' && e.retryAfterMs === 120000);

    let cancelled = false;
    response = () => new Response(new ReadableStream({
        pull(controller) { controller.enqueue(new Uint8Array(65536)); },
        cancel() { cancelled = true; }
    }));
    await assert.rejects(reader.history(input), code('response_limit'));
    assert.equal(cancelled, true, 'stream is cancelled before JSON decode when body grows too large');
    response = () => new Response('small', { headers: { 'content-length': String(READ_LIMITS.responseBytes + 1) } });
    await assert.rejects(reader.history(input), code('response_limit'));
    response = () => { throw new Error('secret CANARY network detail'); };
    await assert.rejects(reader.history(input), e => e.code === 'read_failed' && !e.message.includes('CANARY'));

    response = () => json({ ok: true, messages: [raw(1, { thread_ts: ts(0) })] });
    await reader.replies({ ...input, threadTs: ts(0) });
    assert.equal(calls.at(-1).method, 'conversations.replies');
    assert.equal(calls.at(-1).params.ts, ts(0));
    response = () => json({ ok: true, messages: [] });
    assert.deepEqual(await reader.message({ scope, channelId: 'D123', ts: ts(1) }), { message: null, complete: true });
    assert.equal(calls.at(-1).params.limit, '1');
    assert.equal(calls.at(-1).params.oldest, ts(1));
    assert.equal(calls.at(-1).params.latest, ts(1));

    response = async () => { connected = false; return json({ ok: true, messages: [raw(1)] }); };
    await assert.rejects(reader.history(input), code('cancelled'));
    reader.stop();
    connected = true;
    await assert.rejects(reader.identity(), code('cancelled'));
    let refreshes = 0;
    const refreshing = new SlackReader({ accessToken: async rejected => { refreshes++; return rejected ? 'new' : 'old'; },
        fetch: async (url, options) => options.headers.Authorization === 'Bearer old' ? json({ ok: false, error: 'token_expired' }) : json(identity) });
    await refreshing.identity();
    assert.equal(refreshes, 2, 'definite rejection gets one refresh using the existing OAuth provider');
}

function fixture() {
    let data, time = baseTime, permitted = true, writeCount = 0, failWrite = 0, reads = [];
    let history = async () => page([message(1)]), revalidate = async () => ({ message: message(1), complete: true });
    const store = { get(key) { assert.equal(key, STORE_KEY); return data; },
        set(key, value) { assert.equal(key, STORE_KEY); if (++writeCount === failWrite) throw new Error('disk full'); data = structuredClone(value); } };
    const reader = { identity: async () => scope, history: async args => { reads.push(args); return history(args); }, message: args => revalidate(args) };
    const create = () => new SlackMonitorIntake({ store, readerFor: name => { assert.equal(name, 'slack'); return reader; }, allowed: () => permitted, now: () => time });
    return { store, reader, create, monitor: create(), reads,
        config: { serverName: 'slack', scope, destination: 'local', consent: true },
        get data() { return data; }, set data(value) { data = value; }, get time() { return time; },
        advance(ms = 60000) { time += ms; }, deny() { permitted = false; },
        setHistory(fn) { history = fn; }, setRevalidate(fn) { revalidate = fn; },
        failNextPageWrite() { failWrite = writeCount + 2; } };
}

async function intakeTests() {
    let f = fixture();
    assert.equal((await f.monitor.readOne()).state, 'paused');
    assert.equal(f.reads.length, 0);
    await assert.rejects(f.monitor.configure({ ...f.config, consent: false }), code('consent_required'));
    await f.monitor.configure(f.config);
    assert.equal(f.data.channels[0].through, ts(0), 'activation starts now, never at workspace history origin');
    assert.equal(f.reads.length, 0, 'configuration does not fetch messages');
    f.advance();
    assert.equal((await f.monitor.readOne()).state, 'read');
    assert.equal(f.monitor.pending().messages.length, 1);
    assert.equal(planAnalysis(f.monitor.pending()).coverage.complete, false);
    assert.equal(f.data.channels[0].through, '1770000060.000000');
    const restarted = f.create();
    assert.equal(restarted.pending().messages.length, 1);
    assert.equal((await restarted.readOne()).state, 'waiting');
    f.advance();
    await restarted.readOne();
    assert.equal(restarted.pending().messages.length, 1, 'inclusive boundary/replayed versions deduplicate');

    const ids = planAnalysis(restarted.pending()).messageIds;
    const revision = restarted.status().revision;
    assert.throws(() => restarted.acknowledge({ revision, messageIds: ids, resultRef: 'finding:1', delivered: true }), code('stale_receipt'));
    restarted.acknowledge({ revision, messageIds: ids, resultRef: 'finding:1' });
    assert.equal(restarted.status().analyzed, 1);
    assert.equal(restarted.status().pending, 0);
    f.create().acknowledge({ revision, messageIds: ids, resultRef: 'finding:1', delivered: true });
    assert.equal(f.data.records.length, 0);
    assert.ok(!JSON.stringify(f.data.receipts).includes('Request'), 'delivery receipts retain identity, not raw text');
    f.setRevalidate(async () => ({ message: message(1, { editedTs: ts(50), text: 'Changed request' }), complete: true }));
    f.advance();
    await restarted.revalidate('D123', ts(1));
    assert.equal(f.data.invalidations[0].resultRef, 'finding:1');
    assert.equal(restarted.pending().messages[0].text, 'Changed request');
    assert.throws(() => restarted.acknowledge({ revision, messageIds: ids, resultRef: 'stale' }), code('stale_receipt'));
    f.setRevalidate(async () => ({ message: null, complete: false }));
    f.advance();
    await restarted.revalidate('D123', ts(1));
    assert.equal(restarted.pending().messages.length, 1, 'limited history cannot prove a deletion');
    f.setRevalidate(async () => ({ message: null, complete: true }));
    f.advance();
    await restarted.revalidate('D123', ts(1));
    assert.equal(restarted.pending().messages.length, 0);
    await assert.rejects(restarted.revalidate('D999', ts(1)), code('unknown_message'));

    // A failed page write cannot advance the checkpoint or lose the page.
    f = fixture();
    await f.monitor.configure(f.config);
    f.advance();
    f.failNextPageWrite();
    assert.equal((await f.monitor.readOne()).state, 'store_unavailable');
    assert.equal(f.data.channels[0].through, ts(0));
    assert.equal(f.data.records.length, 0);
    f.advance();
    await f.create().readOne();
    assert.equal(f.data.records.length, 1);
    assert.equal(f.reads[0].latest, f.reads[1].latest, 'retry retains the fixed window after restart');

    // Cursor progress is separate from the completed time checkpoint.
    f = fixture();
    await f.monitor.configure(f.config);
    f.advance();
    f.setHistory(async ({ cursor }) => cursor ? page([message(1)]) : { messages: [message(2)], nextCursor: 'next', complete: false });
    await f.monitor.readOne();
    assert.equal(f.data.channels[0].through, ts(0));
    assert.equal(f.data.channels[0].window.cursor, 'next');
    f.advance();
    await f.create().readOne();
    assert.equal(f.reads[1].cursor, 'next');
    assert.equal(f.data.records.length, 2);
    assert.equal(f.data.channels[0].window, null);
    assert.equal(f.data.channels[0].through, '1770000060.000000');

    // Expired cursors replay the fixed interval, and cycles never advance it.
    f = fixture();
    await f.monitor.configure(f.config);
    f.advance();
    f.setHistory(async () => ({ messages: [message(1)], complete: false, nextCursor: 'next' }));
    await f.monitor.readOne();
    f.advance();
    assert.equal((await f.monitor.readOne()).state, 'pagination_incomplete');
    assert.equal(f.data.channels[0].through, ts(0));
    const windowEnd = f.data.channels[0].window.latest;
    f.advance(120000);
    f.setHistory(async () => { throw new (require('../js/main/slack-monitor-policy').MonitorError)('invalid_cursor', 'expired'); });
    assert.equal((await f.monitor.readOne()).state, 'invalid_cursor');
    assert.equal(f.data.channels[0].window.cursor, '');
    assert.equal(f.data.channels[0].window.latest, windowEnd);
    f.advance(240000);
    f.setHistory(async () => page([message(1)]));
    await f.create().readOne();
    assert.equal(f.data.records.length, 1, 'replaying an expired cursor does not duplicate evidence');
    assert.equal(f.data.channels[0].through, windowEnd);

    // Full queues stop rather than evicting old work, including on byte limits.
    f = fixture();
    await f.monitor.configure(f.config);
    f.advance();
    f.setHistory(async () => page(Array.from({ length: 15 }, (_, i) => message(i, { text: 'x'.repeat(80000) }))));
    assert.equal((await f.monitor.readOne()).state, 'queue_full');
    assert.equal(f.data.records.length, 0);
    assert.equal(f.data.channels[0].through, ts(0));
    assert.ok(JSON.stringify(f.data).length < INTAKE_LIMITS.bytes);
    f.data.records = Array.from({ length: INTAKE_LIMITS.records }, (_, i) => ({ id: `T123:D123:${ts(i)}:original`, message: message(i), status: 'pending' }));
    f.advance();
    const readsBefore = f.reads.length;
    assert.equal((await f.monitor.readOne()).state, 'queue_full');
    assert.equal(f.reads.length, readsBefore);

    f = fixture();
    await f.monitor.configure(f.config);
    f.setHistory(async () => { const e = new (require('../js/main/slack-monitor-policy').MonitorError)('rate_limited', 'wait'); e.retryAfterMs = 180000; throw e; });
    await f.monitor.readOne();
    assert.equal(f.data.channels[0].nextAt, f.time + 180000);
    f.advance(120000);
    assert.equal((await f.create().readOne()).state, 'waiting');
    f.advance(-60000);
    assert.equal((await f.create().readOne()).state, 'waiting', 'clock rollback cannot shorten backoff');

    f = fixture();
    await f.monitor.configure({ ...f.config, scope: { ...scope, conversationIds: ['D123', 'C999'] } });
    f.setHistory(async () => { const e = new (require('../js/main/slack-monitor-policy').MonitorError)('rate_limited', 'wait'); e.retryAfterMs = 180000; throw e; });
    await f.monitor.readOne();
    f.advance(60000);
    assert.equal((await f.create().readOne()).state, 'waiting', 'another selected conversation cannot bypass account Retry-After');
    assert.equal(f.reads.length, 1);

    // Pause, runtime-owner loss and stop must discard late reads.
    for (const action of ['pause', 'stop', 'owner']) {
        f = fixture();
        await f.monitor.configure(f.config);
        let finish;
        f.setHistory(() => new Promise(resolve => { finish = resolve; }));
        const pending = f.monitor.readOne();
        assert.equal((await f.monitor.readOne()).state, 'busy');
        if (action === 'owner') f.deny();
        else f.monitor[action]();
        finish(page([message(1)]));
        assert.equal((await pending).state, 'cancelled');
        assert.equal(f.data.records.length, 0);
        assert.equal(f.reads[0].signal.aborted, action !== 'owner');
    }

    // Late failures and setup identities must not resurrect a stopped monitor.
    f = fixture();
    await f.monitor.configure(f.config);
    let rejectRead;
    f.setHistory(() => new Promise((_, reject) => { rejectRead = reject; }));
    const failingRead = f.monitor.readOne();
    f.monitor.stop();
    rejectRead(new Error('late failure'));
    assert.equal((await failingRead).state, 'cancelled');
    assert.equal(f.data.config, null);
    let finishIdentity;
    f.reader.identity = () => new Promise(resolve => { finishIdentity = resolve; });
    const setup = f.monitor.configure(f.config);
    f.monitor.stop();
    finishIdentity(scope);
    await assert.rejects(setup, code('cancelled'));
    assert.equal(f.data.config, null);

    f = fixture();
    await f.monitor.configure(f.config);
    await f.monitor.readOne();
    const oldRevision = f.monitor.status().revision;
    await f.monitor.configure({ ...f.config, scope: { ...scope, conversationIds: ['C999'] } });
    assert.equal(f.data.records.length, 0, 'removing a conversation purges its local pending text');
    assert.notEqual(f.monitor.status().revision, oldRevision);
    f.data = { version: 1 };
    await assert.rejects(f.create().readOne(), code('store_unavailable'));
    assert.throws(() => f.create().pending(), code('store_unavailable'));

    // Real adapter -> durable queue -> S1 planner, with synthetic HTTP only.
    f = fixture();
    const adapter = new SlackReader({ accessToken: async () => 'fixture-token', fetch: async url =>
        url.endsWith('/auth.test') ? json({ ok: true, team_id: 'T123', user_id: 'U123' })
            : json({ ok: true, messages: [raw(0, { text: 'Please review the launch plan.' })], has_more: false }) });
    const monitor = new SlackMonitorIntake({ store: f.store, readerFor: () => adapter, allowed: () => true, now: () => f.time });
    await monitor.configure(f.config);
    await monitor.readOne();
    const bounded = planAnalysis(monitor.pending());
    assert.equal(bounded.messageIds.length, 1);
    assert.ok(bounded.request.messages[1].content.includes('Please review the launch plan.'));
    assert.equal(bounded.coverage.complete, false);

    // Reopen a real temporary disk store, never the user's settings/data root.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nenva-slack-intake-'));
    try {
        const file = path.join(dir, 'state.json');
        const disk = () => ({ get: () => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : undefined,
            set: (_, state) => { fs.writeFileSync(`${file}.new`, JSON.stringify(state)); fs.renameSync(`${file}.new`, file); } });
        const opts = { readerFor: () => ({ identity: async () => scope, history: async () => page([message(0)]) }), allowed: () => true, now: () => baseTime };
        const one = new SlackMonitorIntake({ ...opts, store: disk() });
        await one.configure({ serverName: 'slack', scope, destination: 'local', consent: true });
        await one.readOne();
        const two = new SlackMonitorIntake({ ...opts, store: disk() });
        assert.equal(two.pending().messages[0].text, 'Request 0');
        two.stop();
        assert.ok(!fs.readFileSync(file, 'utf8').includes('Request 0'));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

(async () => {
    await readerTests();
    await intakeTests();
    console.log('Slack reader and durable intake tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
