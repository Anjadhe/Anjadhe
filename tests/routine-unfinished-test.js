#!/usr/bin/env node
/**
 * A plan is not an answer — the 2026-09-18 finding.
 *
 * A web-grounded routine ("watch for a crack in the AI semiconductor
 * trade") spent its tool budget researching, and the run returned the
 * model's own research voice — "Let me verify the exact 52-week high for
 * SMH and check the 200-day MA" — which posted as three editions in a row.
 * The loop's last iteration withheld the tools without ever SAYING the run
 * was over, so the model simply kept planning.
 *
 * Two things are pinned here. `_looksUnfinished` is the reader, and it is
 * strict in readQuiet's direction: a false positive turns a real digest
 * into an error card, so a planning VERB has to be there and only the
 * opening line and the closing sentence are read at all.
 *
 *   node tests/routine-unfinished-test.js
 */

const PromptFeed = require('../js/apps/prompts/prompt-feed.js');

let failures = 0;
function check(name, cond, detail) {
    if (cond) { console.log(`  ok  ${name}`); return; }
    failures++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
}

const unfinished = (s) => PromptFeed._looksUnfinished(s);

// ── the voice that must never become an edition ──
console.log('a run that ended mid-research');

// The edition this test exists for, verbatim from the feed.
const theEdition = [
    'I have solid data. Let me get the SMH 52-week high from CNBC which showed a 52-week high date and price, and verify the 200-day MA position.',
    '',
    'From the search results:',
    '- CNBC: SMH 52-week high date 06/22/26, 52-week low 301.37 (9/17/25)',
    '- Robinhood: SMH 52-week range $301.37 low to $671.83 high',
    '',
    'Let me verify the exact 52-week high for SMH and check the 200-day MA. Actually, the Robinhood data says 52-week high is $671.83. Current price ~$560.38. That is a drawdown of ~16.6%. Not over 20%.',
    '',
    'Let me confirm with today’s specific data point.'
].join('\n');
check('the edition that was posted', unfinished(theEdition));

check('a plan as the whole answer', unfinished('Let me check the current SMH price first.'));
check('a plan after a preamble on the same line',
    unfinished('I have solid data. Let me get the 52-week high from CNBC.'));
check('a plan as the closing line',
    unfinished('SMH is at $560.\n\nRule 2 is not fired.\n\nNow let me verify the 200-day moving average.'));
check('the first person future', unfinished("I'll search for Nvidia's latest guidance."));
check('with a curly apostrophe', unfinished('I’ll check the hyperscaler earnings next.'));
check('an obligation', unfinished('I need to confirm the closing basis for the index.'));
check('a hedge before the verb', unfinished('Let me just quickly verify the 200-day MA.'));
check('a bulleted last line still reads as a line',
    unfinished('Status: intact.\n- Let me search for the latest SMH close.'));

// ── everything else is an answer, and posts ──
console.log('everything else is an answer');

const goodDigest = [
    'Semiconductor thesis intact, no rule fired.',
    '',
    '**Status: THESIS INTACT — HOLD**',
    '',
    '- RULE 1 — not fired. No hyperscaler reported AI revenue below guidance.',
    '- RULE 2 — not fired. SMH closed at $560.38, 16.6% below its $671.83 52-week high (22 Jun 2026).',
    '- RULE 3 — not fired. SMH is above its 200-day moving average.',
    '',
    'Chip names drifted lower on 17 Sep on memory-pricing chatter, which the routine treats as noise.'
].join('\n');
check('a real digest', !unfinished(goodDigest));

check('an intention is not a plan', !unfinished('Nothing fired today.\n\nI’ll keep watching the index.'));
check('a follow-up offer is not a plan', !unfinished('Three headlines today.\n\nLet me know if you want the sources.'));
check('a verb with no one intending it', !unfinished('Check the closing basis before acting on rule 2.'));
check('the plan-shaped line is buried in the middle', !unfinished(
    'Thesis intact.\n\nOne source said "let me check the tape" in a quoted interview.\n\nNothing fired.'));
check('a quoted plan inside a code fence', !unfinished(
    'Thesis intact.\n\n```\nLet me check the 200-day MA\n```\n\nNo rule fired.'));
check('empty is not unfinished (it is empty)', !unfinished('') && !unfinished(null) && !unfinished(undefined));
check('silence is not unfinished', !unfinished(PromptFeed.QUIET_TOKEN));

// ── the loop's shape ──
console.log('the research loop never writes the answer');
check('rounds are budgeted', PromptFeed.WEB_TOOL_ROUNDS >= 4);
check('there is a synthesis pass', typeof PromptFeed._webSynthesis === 'function');
check('it says research is over', /no more tools/i.test(PromptFeed.SYNTHESIS_TURN));
check('it does not re-author the headline rule',
    !/under ten words/i.test(PromptFeed.SYNTHESIS_TURN));
check('it does not re-author the silence token',
    !PromptFeed.SYNTHESIS_TURN.includes(PromptFeed.QUIET_TOKEN));
check('the failure is final, never retried as an outage',
    !PromptFeed._isTransient(PromptFeed.UNFINISHED_ERROR));

// ── the loop, driven ──
// Stubs standing in for the brain and the tools: the model researches, then
// answers with a plan while tools are still on the table. The loop must ask
// for the post instead of returning that plan.
console.log('the loop asks for the post');

global.NotePrompts = {
    config: () => ({ interval: 'weekdays', time: '17:00', web: true }),
    scheduleLabel: () => 'weekdays at 5:00 PM',
    bodyText: (p) => p.content || ''
};
global.AgentTools = {
    definitions: [{ type: 'function', function: { name: 'web_search', description: 'search', parameters: {} } }],
    _webRunTools: new Set(),
    execute: async () => ({ results: [{ title: 'SMH closes at $560.38', url: 'https://example.com' }] })
};

async function driveRun(turns) {
    const seen = [];
    global.LLMLogger = {
        call: async (tag, params) => {
            seen.push({
                tools: !!params.tools,
                last: params.messages[params.messages.length - 1],
                messages: params.messages.map(m => ({ role: m.role, tool_call_id: m.tool_call_id, tool_calls: m.tool_calls }))
            });
            return turns.shift() || { message: { content: '' } };
        }
    };
    PromptFeed._current = { cancelled: false };
    const out = await PromptFeed._generateWithWeb({ id: 'r1', title: 'Crack watch', content: 'watch the trade' }, 'test-model');
    PromptFeed._current = null;
    return { out, seen };
}

(async () => {
    const searched = { message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'web_search', arguments: '{"query":"SMH"}' } }] } };

    // 1. Researches, then plans, then answers when asked.
    let r = await driveRun([
        searched,
        { message: { role: 'assistant', content: 'I have solid data. Let me verify the 200-day MA.' } },
        { message: { role: 'assistant', content: 'Thesis intact.\n\nSMH at $560.38, 16.6% off its high. No rule fired.' } }
    ]);
    check('a plan mid-loop does not end the run', /Thesis intact/.test(r.out.content), JSON.stringify(r.out));
    check('the answer was asked for with no tools', r.seen[2] && r.seen[2].tools === false);
    check('and the ask names the end of research',
        r.seen[2] && r.seen[2].last.content === PromptFeed.SYNTHESIS_TURN);
    check('no error on a run that finished', r.out.error === null);

    // 2. Still planning after being asked: an error card, never the plan.
    r = await driveRun([
        searched,
        { message: { role: 'assistant', content: 'Let me check the 52-week high.' } },
        { message: { role: 'assistant', content: 'Now let me confirm the 200-day MA.' } }
    ]);
    check('a plan after the ask becomes an error', r.out.error === PromptFeed.UNFINISHED_ERROR, JSON.stringify(r.out));
    check('and nothing is posted', !r.out.content);

    // 3. A clean answer on the first turn still returns straight away.
    r = await driveRun([{ message: { role: 'assistant', content: 'Nothing fired today.\n\nSMH at $560.38.' } }]);
    check('a finished first answer ends the run', /Nothing fired/.test(r.out.content));
    check('with one model call and no ask', r.seen.length === 1);

    // ── every result names the call it answers ──
    // The Anthropic 400 of 2026-09-18: "unexpected `tool_use_id` found in
    // `tool_result` blocks: tool_2. Each tool_result block must have a
    // corresponding tool_use block in the previous message." The loop pushed
    // results with no tool_call_id; llama.cpp and the cloud proxy did not
    // care, the official APIs do.
    console.log('a tool result names its call');
    r = await driveRun([
        { message: { role: 'assistant', content: '', tool_calls: [
            { id: 'toolu_01A', function: { name: 'web_search', arguments: '{"query":"SMH"}' } },
            { id: 'toolu_01B', function: { name: 'web_search', arguments: '{"query":"SOXX"}' } }
        ] } },
        { message: { role: 'assistant', content: 'Thesis intact.\n\nNo rule fired.' } }
    ]);
    const second = r.seen[1].messages;
    const results = second.filter(m => m.role === 'tool');
    check('one result per call', results.length === 2, JSON.stringify(results));
    check('each carries the call id it answers',
        results[0].tool_call_id === 'toolu_01A' && results[1].tool_call_id === 'toolu_01B',
        JSON.stringify(results));
    const echoed = second.find(m => m.role === 'assistant' && m.tool_calls);
    check('and the echoed assistant turn carries the same ids',
        echoed.tool_calls.map(t => t.id).join(',') === 'toolu_01A,toolu_01B');

    // A brain that emits no id of its own still leaves the pair matched.
    r = await driveRun([
        { message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'web_search', arguments: '{}' } }] } },
        { message: { role: 'assistant', content: 'Thesis intact.\n\nNo rule fired.' } }
    ]);
    const msgs = r.seen[1].messages;
    const call = msgs.find(m => m.role === 'assistant' && m.tool_calls).tool_calls[0];
    const result = msgs.find(m => m.role === 'tool');
    check('an id-less call is paired anyway',
        !!call.id && call.id === result.tool_call_id, JSON.stringify({ call, result }));

    console.log(failures ? `\n${failures} failing` : '\nall good');
    process.exit(failures ? 1 : 0);
})();
