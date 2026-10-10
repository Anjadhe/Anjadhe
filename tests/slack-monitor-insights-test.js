'use strict';
const assert = require('node:assert/strict');
const Matters = require('../js/core/matters');
const { SlackInsightDelivery } = require('../js/main/slack-monitor-insights');
const { SlackMonitorIntake, STORE_KEY } = require('../js/main/slack-monitor-intake');
const { SlackAnalysisBudget, planAnalysis } = require('../js/main/slack-monitor-policy');
const NOW = Date.parse('2026-10-07T12:00:00Z');
const scope = { workspaceId: 'T123', userId: 'U123', conversationIds: ['D123'] };
const model = { id: 'local', engine: 'llamacpp', model: 'local-12b', label: 'Local' };
const ts = n => `${Math.floor(NOW / 1000)}.${String(n).padStart(6, '0')}`;
const msg = (n, text, extra = {}) => ({ kind: 'message', workspaceId: 'T123', channelId: 'D123', userId: 'U456',
    ts: ts(n), editedTs: null, threadTs: ts(0), text, attachmentsOmitted: false, hasReplies: true, ...extra });
const request = msg(1, 'Please review proposal ref PROP123 by 2026-10-12.');
const judgment = extra => ({ about: 'new', title: 'Launch proposal', status: 'Needs review', kind: 'other', change: 'new', tell: 'morning',
    next: { what: 'Review the proposal', quote: request.text, how: 'none', yours: true, by: '2026-10-12', by_quote: 'by 2026-10-12' }, ...extra });

async function fixture() {
    const data = new Map(); let permitted = true, calls = [], answers = [], auth = () => true, onFetch = () => {}, failKey = null;
    const store = { get: k => data.has(k) ? structuredClone(data.get(k)) : undefined,
        set(k, v) { if (k === failKey) { failKey = null; throw new Error('disk full'); } data.set(k, structuredClone(v)); } };
    const intake = new SlackMonitorIntake({ store, readerFor: () => ({ identity: async () => scope }), allowed: () => permitted, now: () => NOW });
    await intake.configure({ serverName: 'slack', scope, destination: 'local', consent: true, analysisModel: model });
    const budget = new SlackAnalysisBudget({ store, now: () => NOW });
    const create = () => new SlackInsightDelivery({ store, intake, budget, now: () => NOW,
        authorize: input => auth(input), provider: async approved => ({ url: 'https://model.example/v1/chat/completions', headers: {},
            body: (messages, max_tokens) => ({ model: approved.model, messages, max_tokens, stream: false }) }),
        fetch: async (_url, input) => {
            calls.push(JSON.parse(input.body)); onFetch();
            assert.ok(Buffer.byteLength(input.body) <= 16384);
            assert.ok(answers.length, 'unexpected model call');
            return Response.json({ choices: [{ message: { content: JSON.stringify(answers.shift()) }, finish_reason: 'stop' }] });
        } });
    const f = { store, data, intake, create, service: create(), calls,
        answers(...values) { answers = values; }, authorize(fn) { auth = fn; }, onFetch(fn) { onFetch = fn; }, failWrite(k) { failKey = k; },
        input(message = request, kind = 'request') {
            const state = intake._read(); intake._ingest(state, message.channelId, [message]); intake._save(state);
            const pending = intake.pending(), plan = planAnalysis(pending);
            return { revision: pending.revision, plan, text: JSON.stringify({ findings: [{ kind, summary: kind === 'resolution' ? 'Proposal finished' : 'Review the proposal', quote: message.text, messageIds: plan.messageIds }] }) };
        },
        get matters() { return store.get('app_matters'); }
    };
    return f;
}

async function delivery() {
    let f = await fixture(); f.answers(judgment());
    const input = f.input();
    const result = await f.service.file(input);
    const m = Object.values(f.matters.matters)[0];
    assert.equal(m.sources[0].kind, 'slack'); assert.equal(m.sources[0].slack.coverage.complete, false);
    assert.equal(m.next.by, '2026-10-12'); assert.ok(m.sources[0].slack.sourceUrl.startsWith('https://slack.com/app_redirect?'));
    assert.ok(!JSON.stringify(f.matters).includes(request.text), 'raw quote is not copied into the synced matter blob');
    assert.equal(f.intake.status().pending, 0); assert.equal(f.intake._read().receipts[0].resultRef, result.resultRef);
    assert.equal((await f.create().file(input)).replayed, true); assert.equal(f.calls.length, 1);

    // Existing email matter + existing task: one shared folder and task link.
    f = await fixture();
    f.store.set('app_matters', { version: 2, aliases: {}, matters: { email: { id: 'email', title: 'Launch proposal', kind: 'other', state: 'open',
        when: { date: '2026-10-12' }, ids: ['prop123'], sources: [{ id: 'email:1', kind: 'email', summary: 'Proposal review' }] } } });
    f.store.set('app_schedule', { scheduleItems: [{ id: 'task:1', title: 'Review proposal', scheduledDate: '2026-10-12' }] });
    f.store.set('app_commitments', { items: [{ id: 'task:1', title: 'Review proposal', state: 'open', when: { date: '2026-10-12' }, repeat: { rule: 'none' } }], ledger: [], tombstones: {} });
    let sawClasses;
    f.authorize(({ sources }) => { if (sources.includes('email')) sawClasses = sources; return true; });
    f.answers(judgment({ about: 'M1', change: 'changed', task: 'T1', next: { ...judgment().next, is_task: true } }));
    await f.service.file(f.input());
    assert.equal(Object.keys(f.matters.matters).length, 1);

    assert.equal(f.matters.matters.email.next.taskId, 'task:1');
    assert.deepEqual(f.matters.matters.email.tasks, ['task:1']);
    assert.ok(sawClasses.includes('commitment'), 'mixed-source privacy is passed to main authorization');
    f.answers(judgment({ about: 'M1', change: 'done', status: 'Completed', next: null, resolution_quote: 'I finished the proposal review.' }));
    await f.service.file(f.input(msg(2, 'I finished the proposal review.', { userId: scope.userId }), 'resolution'));
    assert.equal(f.matters.matters.email.state, 'done'); assert.equal(f.matters.matters.email.next.state, 'done');
    assert.equal(f.matters.matters.email.sources.at(-1).tell, 'file', 'own resolution is quiet');
    assert.equal(Object.keys(f.matters.matters).length, 1);

    // A repeated request cannot reopen the completed matter or its step.
    f.answers(judgment({ about: 'M1', change: 'changed' }), { same: true });
    await f.service.file(f.input(msg(3, request.text)));
    assert.equal(f.matters.matters.email.state, 'done');
    assert.equal(f.matters.matters.email.next.state, 'done');
    assert.equal(f.matters.matters.email.sources.at(-1).tell, 'file');

    f = await fixture(); const empty = f.input(); empty.text = '{"findings":[]}';
    await f.service.file(empty); assert.equal(f.calls.length, 0); assert.equal(f.intake.status().pending, 0);
    assert.equal(Object.keys(f.matters.matters).length, 0, 'nothing meaningful creates no folder');
}

async function failures() {
    let f = await fixture(), input = f.input(); f.answers(judgment()); f.failWrite('app_matters');
    await assert.rejects(f.service.file(input), /disk full/);
    assert.equal(f.matters, undefined); assert.equal(f.intake.status().pending, 1);
    f.answers(judgment()); await f.service.file(input); assert.equal(f.calls.length, 2, 'failed persistence does not fake successful delivery');

    f = await fixture(); input = f.input(); f.answers(judgment());
    f.onFetch(() => f.failWrite(STORE_KEY));
    await assert.rejects(f.service.file(input));
    assert.equal(Object.keys(f.matters.matters).length, 1, 'shared write succeeded before acknowledgement failed');
    assert.equal(f.intake.status().pending, 1);
    assert.equal((await f.create().file(input)).replayed, true);
    assert.equal(f.calls.length, 1, 'restart repairs acknowledgement without another model call');

    // An edit after that same crash must invalidate the already-saved matter,
    // even though intake still calls the original record "pending".
    f = await fixture(); input = f.input(); f.answers(judgment()); f.onFetch(() => f.failWrite(STORE_KEY));
    await assert.rejects(f.service.file(input));
    const restarted = f.create(), state = f.intake._read();
    f.intake._ingest(state, 'D123', [msg(1, 'Changed request', { editedTs: ts(2) })]); f.intake._save(state);
    assert.equal(f.intake.status().invalidations, 1);
    await restarted.invalidate({ revision: input.revision });
    assert.equal(Object.values(f.matters.matters)[0].evidenceNeedsReview, true);

    f = await fixture(); input = f.input(); f.answers(judgment());
    f.onFetch(() => f.store.set('app_matters', { version: 2, matters: {}, aliases: {}, userEdit: true }));
    await assert.rejects(f.service.file(input), e => e.code === 'matter_changed');
    assert.equal(f.matters.userEdit, true); assert.equal(f.intake.status().pending, 1);

    f = await fixture(); input = f.input(); f.answers(judgment()); f.onFetch(() => f.intake.pause());
    await assert.rejects(f.service.file(input)); assert.equal(f.matters, undefined);
    f = await fixture(); input = f.input(); f.authorize(() => false);
    await assert.rejects(f.service.file(input), e => e.code === 'not_authorized'); assert.equal(f.calls.length, 0);
    f = await fixture(); input = f.input(); f.authorize(async () => true);
    await assert.rejects(f.service.file(input), e => e.code === 'not_authorized'); assert.equal(f.calls.length, 0, 'async authorization is not a live grant');

    f = await fixture(); input = f.input(); f.answers(judgment());
    f.onFetch(() => { const state = f.intake._read(); f.intake._ingest(state, 'D123', [msg(1, 'Changed request', { editedTs: ts(2) })]); f.intake._save(state); });
    await assert.rejects(f.service.file(input), e => e.code === 'stale_evidence');
    assert.equal(f.matters, undefined, 'editing a message during inference invalidates its old finding');

    f = await fixture(); input = f.input(); f.answers(judgment());
    f.onFetch(() => f.store.set('app_commitments', { items: [], ledger: [{ userEdit: true }] }));
    await assert.rejects(f.service.file(input), e => e.code === 'matter_changed'); assert.equal(f.matters, undefined);

    f = await fixture(); input = f.input(); f.answers(judgment({ next: { ...judgment().next, quote: 'invented evidence' } }));
    await assert.rejects(f.service.file(input), e => e.code === 'filing_incomplete'); assert.equal(f.intake.status().pending, 1);
}

async function secondLooks() {
    // A narrow identity check must retain the other source's privacy class.
    let narrow = await fixture();
    narrow.store.set('app_matters', { version: 2, aliases: {}, matters: { email: { id: 'email', title: 'Launch proposal', kind: 'other', state: 'open',
        when: { date: '2026-10-20' }, ids: ['prop123'], sources: [{ id: 'email:1', kind: 'email', summary: 'Proposal review' }] } } });
    narrow.answers(judgment({ about: 'M1', change: 'changed', when: '2026-10-12' }), { same: true });
    narrow.authorize(({ sources }) => {
        if (narrow.calls.length === 1) assert.ok(sources.includes('email'), 'narrow send retains the email privacy class');
        return true;
    });
    await narrow.service.file(narrow.input());
    assert.equal(narrow.calls.length, 2); assert.equal(narrow.calls[1].max_tokens, 40);
    assert.equal(narrow.store.get('slackMonitorAnalysisBudget').reservations.length, 2);

    let f = await fixture();
    f.store.set('app_matters', { version: 2, aliases: {}, matters: { mail: { id: 'mail', title: 'Launch proposal', kind: 'other', state: 'open', ids: [],
        updatedAt: new Date(NOW).toISOString(), sources: [{ id: 'mail:1', kind: 'email', summary: 'Proposal' }] } } });
    f.answers(judgment(), judgment({ about: 'M1', change: 'changed' }));
    await f.service.file(f.input());
    assert.equal(f.calls.length, 2); assert.equal(Object.keys(f.matters.matters).length, 1);
    assert.equal(f.store.get('slackMonitorAnalysisBudget').reservations.length, 2, 'every follow-up reserves the same Slack budget');

    f = await fixture();
    f.store.set('app_matters', { version: 2, aliases: {}, matters: { mail: { id: 'mail', title: 'Launch proposal', kind: 'other', state: 'open', ids: [],
        updatedAt: new Date(NOW).toISOString(), sources: [{ id: 'mail:1', kind: 'email', summary: 'Proposal' }] } } });
    f.answers(judgment(), {});
    await assert.rejects(f.service.file(f.input()), e => e.code === 'filing_incomplete');
    assert.equal(Object.keys(f.matters.matters).length, 1, 'failed second look must not make a duplicate');
    assert.equal(f.intake.status().pending, 1);

    // A class the user did not approve is refused before the follow-up send.
    f.authorize(({ sources }) => !sources.includes('email')); f.answers(judgment());
    const count = f.calls.length;
    await assert.rejects(f.service.file({ ...f.input(), text: JSON.stringify({ findings: [{ kind: 'request', summary: 'Review proposal', quote: request.text, messageIds: planAnalysis(f.intake.pending()).messageIds }] }) }));
    assert.equal(f.calls.length, count + 1, 'only the Slack-only first look may leave');
    assert.equal(Object.keys(f.matters.matters).length, 1);
}

async function invalidation() {
    const f = await fixture(); f.answers(judgment()); const input = f.input();
    await f.service.file(input);
    const state = f.intake._read();
    f.intake._ingest(state, 'D123', [{ kind: 'unavailable', ts: request.ts }]); f.intake._save(state);
    f.failWrite('app_matters'); await assert.rejects(f.service.invalidate({ revision: input.revision }));
    assert.equal(f.intake.status().invalidations, 1);
    await f.service.invalidate({ revision: input.revision });
    const m = Object.values(f.matters.matters)[0];
    assert.equal(m.state, 'open', 'unavailability is not proof of resolution');
    assert.equal(m.evidenceNeedsReview, true); assert.equal(Matters.openStep(m), null);
    assert.equal(f.intake.status().invalidations, 0); assert.equal(f.calls.length, 1, 'invalidation is local bookkeeping');
}

async function ordinaryRoute() {
    const Privacy = require('../js/core/cloud-privacy');
    assert.equal(Privacy.guardSource('slack-matter').blocked, true, 'generic logger cannot fall back to a local or cloud brain');
    let calls = 0;
    global.AgentService = { model: 'default' };
    global.LLMLogger = { call: async () => { calls++; throw new Error('Slack must not reach the generic model route'); } };
    const m = { id: 'mixed', title: 'Proposal', state: 'open', kind: 'other', ids: ['prop123'], sources: [{ id: 'slack:old', kind: 'slack' }] };
    const service = Object.create(Matters); service._data = { version: 2, matters: { mixed: m }, aliases: {} };
    service._queue = Promise.resolve(); service._save = () => {};
    const out = await service.observe(service.observation({ id: 'email:new', source: 'email', title: 'ref PROP123', text: 'An update' }));
    assert.ok(out.error); assert.equal(calls, 0);
    assert.equal(await service.sameThing(service._describe(m), { title: 'Proposal' }), null); assert.equal(calls, 0);
    assert.deepEqual(service.forAmbient(), [], 'ordinary ambient consumers get no unbudgeted Slack-derived matter');
    const email = { id: 'email', title: 'Proposal', sources: [{ kind: 'email', id: 'e1' }], state: 'open' };
    service.mergeInto(email, m);
    email.sources = email.sources.filter(s => s.kind !== 'slack');
    assert.equal(service.needsBounded(email), true, 'removing a source does not erase privacy provenance from derived words');
    delete global.AgentService; delete global.LLMLogger;
}

(async () => { await delivery(); await failures(); await secondLooks(); await invalidation(); await ordinaryRoute();
    console.log('Slack insights: shared filing, cross-source links, bounded follow-ups, durable replay and invalidation passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
