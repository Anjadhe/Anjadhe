#!/usr/bin/env node
/**
 * RoutineLook — the scheduled look's pure core and its run wiring
 * (docs/ROUTINES_UX.md "Routines are instructions", I3–I6).
 */
const assert = require('assert');
const L = require('../js/core/routine-look.js');

// ── foundIn: numbers must all be there; words must appear whole ──
assert.equal(L.foundIn('01NOV13', 'Final action EB-2 India 01NOV13'), true);
assert.equal(L.foundIn('01NOV13', 'EB-2 India 15JAN15'), false);
assert.equal(L.foundIn('Unavailable', 'EB-2 India: unavailable (U)'), true);
assert.equal(L.foundIn('Current', 'EB-2 Worldwide C'), false);
assert.equal(L.foundIn('01DEC13', 'EB-2 India 01NOV13'), false, 'a date code keeps its month');
assert.equal(L.foundIn('1,250.5', 'cost 1250.50 today'), true);

// ── vetReport (I5) ──
const notebook = 'October 2026 bulletin. EB-2 India FAD: U. EB-3 India FAD: 01JAN14. https://travel.state.gov/x';
const readText = '{"text":"Visa Bulletin for November 2026 ... EB-2 India 01NOV13 ... EB-3 India 01JAN14"}';
const known = new Set(L.nums(`${notebook} ${readText}`));
const ok = (args, extra = {}) => L.vetReport(args, { notebook, readText, readOk: true, known, reported: false, ...extra });
const change = (o) => ({ kind: 'change', headline: 'EB-2 India moved to 01NOV13', body: 'The November bulletin moved EB-2 India.', card: true, changes: [o] });

let r = ok(change({ what: 'EB-2 India FAD', before: 'U', after: '01NOV13' }));
assert.ok(r.report, JSON.stringify(r));
assert.equal(r.report.card, true);
assert.deepEqual(r.report.changes, [{ what: 'EB-2 India FAD', before: 'U', after: '01NOV13' }]);

r = ok(change({ what: 'EB-2 India FAD', before: '15SEP12', after: '01NOV13' }));
assert.match(r.error, /not what your notebook holds/, 'a before value the notebook does not hold is refused');

r = ok(change({ what: 'EB-2 India FAD', before: 'U', after: '01DEC13' }));
assert.match(r.error, /not in anything you read/, 'an after value nobody read is refused');

r = ok(change({ what: 'EB-3 India FAD', before: '01JAN14', after: '01JAN14' }));
assert.match(r.error, /not a change/, 'an unchanged value is not a change');

r = ok(change({ what: 'EB-2 India FAD', before: 'U', after: '01NOV13' }), { readOk: false });
assert.match(r.error, /Nothing was read successfully/, 'a failed read is never news');

r = ok(change({ what: 'EB-2 India FAD', before: 'U', after: '01NOV13' }), { reported: true });
assert.match(r.error, /already reported/);

r = ok({ kind: 'delivery', headline: 'EB-2 India jumped 7 months', body: 'x', card: true, changes: [] });
assert.match(r.error, /headline are not in anything you read/, 'a headline number nobody read is refused');

r = ok({ kind: 'delivery', headline: 'Quantum: two new logical-qubit results', body: 'A roundup.', card: false });
assert.ok(r.report && r.report.card === false && r.report.changes.length === 0, 'a delivery without changes reports');

r = ok({ kind: 'delivery', headline: 'x'.repeat(120), body: 'y', card: false });
assert.match(r.error, /too long/);
r = ok({ kind: 'change', headline: 'Bulletin unchanged', body: 'Same as before.', card: false, changes: [] });
assert.match(r.error, /do not report/, 'a change report must list its changes');
r = ok({ headline: 'x', body: 'y', card: false });
assert.match(r.error, /"kind" must be/);
// unchanged(): a no-change report over an identical notebook is nothing new (a fact)
assert.equal(L.unchanged({ changes: [] }, notebook, { text: notebook }), true);
assert.equal(L.unchanged({ changes: [] }, notebook + ' Nov.', { text: notebook }), false);
assert.equal(L.unchanged({ changes: [{}] }, notebook, { text: notebook }), false);
r = ok({ kind: 'delivery', headline: 'x'.repeat(120), body: 'y', card: false });
assert.match(r.error, /too long/);

r = L.vetReport(change({ what: 'EB-2 India FAD', before: 'U', after: '01NOV13' }), { notebook: '', readText, readOk: true, known, reported: false });
assert.match(r.error, /notebook is empty/, 'with no notebook, before must be empty');
r = L.vetReport(change({ what: 'EB-2 India FAD', before: '', after: '01NOV13' }), { notebook: '', readText, readOk: true, known, reported: false });
assert.ok(r.report, 'with no notebook, a change may state only its after');

// I9: a watch the person chose takes only changes
r = ok({ kind: 'delivery', headline: 'The October bulletin is current', body: 'Same table.', card: false }, { tells: 'change' });
assert.match(r.error, /ONLY when something it watches changes/);
assert.ok(ok({ kind: 'delivery', headline: 'Quantum: one new result', body: 'b', card: false }, { tells: 'each' }).report);
assert.match(L.inputText({ title: 'x', body: 'y', now: new Date(), tells: 'change', saysBack: 'check it and tell you when it changes' }), /THEY CHOSE: tell them ONLY when/);

// changes as lines (small models cannot fill nested objects)
r = ok({ kind: 'change', headline: 'EB-2 India moved to 01NOV13', body: 'b', card: true, changes: ['EB-2 India FAD: U → 01NOV13'] });
assert.deepEqual(r.report.changes, [{ what: 'EB-2 India FAD', before: 'U', after: '01NOV13' }]);
assert.deepEqual(L.parseChange('Chart honored: -> Dates for Filing'), { what: 'Chart honored', before: '', after: 'Dates for Filing' });
assert.deepEqual(L.parseChange('EB-3 India: 15FEB14'), { what: 'EB-3 India', before: '', after: '15FEB14' });
assert.equal(L.parseChange('no colon here'), null);

// ── vetKeep ──
assert.equal(L.vetKeep({ text: 'Nov 2026 bulletin: EB-2 India 01NOV13' }, { known }).text, 'Nov 2026 bulletin: EB-2 India 01NOV13');
assert.match(L.vetKeep({ text: 'EB-2 India 15MAR14' }, { known }).error, /not in anything you read/);
assert.match(L.vetKeep({ text: 'z'.repeat(L.NOTEBOOK_MAX + 1) }, { known }).error, /Too long/);
assert.match(L.vetKeep({ text: ' ' }, { known }).error, /needs text/);

// ── cardOf (I6) ──
assert.deepEqual(L.cardOf({ headline: 'EB-2 India moved', changes: [{ what: 'EB-2 India FAD', before: 'U', after: '01NOV13' }, { what: 'Chart', before: '', after: 'Dates for Filing' }] }),
    { title: 'EB-2 India moved', body: 'EB-2 India FAD: U → 01NOV13 · Chart: Dates for Filing' });
assert.equal(L.cardOf(null), null);

// ── notebookOf / saidSince / inputText (I3) ──
const isRun = m => !!(m && m.metadata && m.metadata.routineRun);
const conv = { standing: { notebook: { text: notebook, at: '2026-10-08T15:00:00Z' } }, messages: [
    { role: 'user', content: 'old' },
    { role: 'assistant', content: 'run', metadata: { routineRun: { id: 'a' } } },
    { role: 'user', content: 'only tell me when EB-2 India moves' },
    { role: 'assistant', content: 'Okay.' }
] };
assert.equal(L.notebookOf(conv).text, notebook);
assert.equal(L.notebookOf({ standing: {} }), null);
assert.deepEqual(L.saidSince(conv, isRun), ['only tell me when EB-2 India moves']);

const now = new Date(2026, 9, 9, 8, 0);
let input = L.inputText({ title: 'Visa bulletin', body: 'Tell me when EB-2 India moves.', schedule: 'daily at 8:00', now, notebook: L.notebookOf(conv),
    lastRuns: [{ at: '2026-10-08T15:00:00Z', content: 'October bulletin: EB-2 India U' }], said: L.saidSince(conv, isRun),
    lastQuiet: { at: '2026-10-09T01:00:00Z', reason: 'Same October bulletin' }, memory: ['My priority date is Oct 2014.'] });
assert.match(input, /YOUR NOTEBOOK — what you kept/);
assert.match(input, /EB-3 India FAD: 01JAN14/);
assert.match(input, /WHAT THEY WERE ALREADY TOLD/);
assert.match(input, /only tell me when EB-2 India moves/);
assert.match(input, /found nothing new .*Same October bulletin/);
assert.match(input, /My priority date is Oct 2014/);
input = L.inputText({ title: 'x', body: 'y', now });
assert.match(input, /NOTEBOOK is empty/);
assert.doesNotMatch(input, /ALREADY TOLD/);

// ── run(): the wiring, driven by a scripted model ──
(async () => {
    const script = [];
    global.AgentLoop = { async run(o) {
        for (const step of script) {
            if (step.text !== undefined) return { text: step.text, stop: 'done' };
            step.result = await o.execute(step.name, step.args);
        }
        return { text: 'done', stop: 'done' };
    } };
    const reads = { web_search: { results: [{ title: 'Visa Bulletin For November 2026', content: 'EB-2 India 01NOV13; EB-3 India 01JAN14' }] } };
    global.AgentTools = {
        definitions: ['web_search', 'read_url', 'recall_memory', 'list_commitments'].map(name => ({ type: 'function', function: { name } })),
        async execute(name) { return reads[name] || { error: 'blocked page (403)' }; }
    };
    const conv2 = { id: 'r1', title: 'Visa bulletin', standing: { body: 'Tell me when EB-2 India moves.', config: {}, notebook: { text: notebook, at: '2026-10-08T15:00:00Z' } }, messages: [] };
    global.NotePrompts = {
        conversationOf: () => conv2, config: () => ({ web: true, useContext: false, trigger: { type: 'time' } }),
        runs: () => [], bodyText: () => conv2.standing.body, scheduleLabel: () => 'daily at 8:00', isRun
    };
    global.window = { electronSearch: { getStatus: async () => ({ enabled: true, unset: false }) } };

    // A failed read is not news: the change is refused, nothing reported.
    script.splice(0, script.length,
        { name: 'read_url', args: { url: 'https://travel.state.gov/x' } },
        { name: 'report', args: change({ what: 'EB-2 India FAD', before: 'U', after: '01NOV13' }) },
        { text: 'Could not read the bulletin page (403).' });
    let out = await L.run({ id: 'r1', title: 'Visa bulletin' });
    assert.equal(out.report, null, 'nothing read, nothing reported');
    assert.match(script[1].result.error, /Nothing was read successfully/);
    assert.equal(out.reason, 'Could not read the bulletin page (403).');

    // A real change: read, kept, reported with a card.
    script.splice(0, script.length,
        { name: 'web_search', args: { query: 'visa bulletin November 2026' } },
        { name: 'keep', args: { text: 'November 2026 bulletin. EB-2 India FAD: 01NOV13. EB-3 India FAD: 01JAN14.' } },
        { name: 'report', args: change({ what: 'EB-2 India FAD', before: 'U', after: '01NOV13' }) },
        { text: 'Reported the EB-2 India move.' });
    out = await L.run({ id: 'r1', title: 'Visa bulletin' });
    assert.ok(out.report && out.report.card, JSON.stringify(script[2].result));
    assert.equal(out.keep, 'November 2026 bulletin. EB-2 India FAD: 01NOV13. EB-3 India FAD: 01JAN14.');

    // Web search the person never turned on is not offered unattended.
    let offered = null;
    global.AgentLoop = { async run(o) { offered = o.tools.map(t => t.function.name); return { text: 'Nothing new.', stop: 'done' }; } };
    global.window = { electronSearch: { getStatus: async () => ({ unset: true }) } };
    out = await L.run({ id: 'r1', title: 'Visa bulletin' });
    assert.ok(!offered.includes('web_search') && offered.includes('read_url') && offered.includes('report'), offered.join(','));
    assert.equal(out.report, null);
    assert.equal(out.reason, 'Nothing new.');

    console.log('routine-look: checks, input, card and run wiring passed');
})().catch(e => { console.error(e); process.exit(1); });
