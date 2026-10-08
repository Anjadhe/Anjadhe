'use strict';
// Exercise the production prompt clamp and Anthropic conversion without
// starting Electron or sending user data to a model.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
function section(start, end) {
    const from = source.indexOf(start), to = source.indexOf(end, from);
    assert.ok(from >= 0 && to > from, `Production section exists: ${start}`);
    return source.slice(from, to);
}
const ctx = vm.createContext({});
vm.runInContext(section('const CLOUD_BG_PROMPT_CHARS =', 'const withLLMScheduler =')
    + section('function toAnthropicPayload(', '// Add a cache breakpoint')
    + '\nthis.clamp = clampBackgroundPrompt; this.convert = toAnthropicPayload;', ctx);
const { clamp, convert } = ctx;
const LIMIT = 48000;
const textSize = messages => messages.reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : 0), 0);
const plain = value => JSON.parse(JSON.stringify(value));
function exchange(round, resultSize = 6000) {
    const calls = [0, 1].map(i => ({ id: `toolu_research_${round}_${i}`, function: { name: 'read_url', arguments: JSON.stringify({ url: `https://example.test/${round}/${i}` }) } }));
    return [{ role: 'assistant', content: '', tool_calls: calls,
        _anthropicContent: [{ type: 'thinking', thinking: 'Synthetic signed thinking.', signature: `signature-${round}` },
            ...calls.map(call => ({ type: 'tool_use', id: call.id, name: call.function.name, input: JSON.parse(call.function.arguments) }))] },
    ...calls.map((call, i) => ({ role: 'tool', name: 'read_url', tool_call_id: call.id, content: `${round}:${i}:` + 'x'.repeat(resultSize) }))];
}
function assertPaired(messages) {
    const payload = plain(convert(messages).messages);
    for (let i = 0; i < payload.length; i++) {
        const message = payload[i];
        const blocks = Array.isArray(message.content) ? message.content : [];
        const calls = blocks.filter(block => block.type === 'tool_use').map(block => block.id);
        if (calls.length) {
            const next = payload[i + 1];
            assert.equal(next?.role, 'user', 'Tool calls have a following result turn');
            const results = Array.isArray(next.content) ? next.content.filter(block => block.type === 'tool_result') : [];
            assert.deepEqual(results.map(block => block.tool_use_id), calls, 'Every tool_use has its matching tool_result immediately after');
            assert.ok(next.content.slice(0, calls.length).every(block => block.type === 'tool_result'), 'Results precede any text/images');
        }
        const results = blocks.filter(block => block.type === 'tool_result');
        if (results.length) {
            const previous = payload[i - 1];
            assert.equal(previous?.role, 'assistant');
            assert.deepEqual(results.map(block => block.tool_use_id), previous.content.filter(block => block.type === 'tool_use').map(block => block.id), 'No orphan results');
        }
    }
}

// The reported failure: several parallel research rounds cross the background
// text budget. Dropping individual recent results leaves older tool_use blocks.
const research = [{ role: 'system', content: 'Research with evidence.' }, { role: 'user', content: 'Compare these sources.' },
    ...Array.from({ length: 5 }, (_, i) => exchange(i)).flat()];
const params = { messages: structuredClone(research) };
clamp(params);
assert.equal(params._clamped, true);
assert.deepEqual(params.messages.find(m => m.role === 'user'), research[1], 'Keep the assignment that initiated the tool loop');
assertPaired(params.messages);
assert.ok(textSize(params.messages) <= LIMIT);
assert.ok(params.messages.some(m => m.tool_call_id === 'toolu_research_4_0'), 'Keep the newest complete batch');
assert.ok(!params.messages.some(m => m.tool_call_id === 'toolu_research_0_0'), 'Remove the oldest batch first');
assert.deepEqual(params.messages.slice(-3), research.slice(-3), 'Newest evidence remains intact when it fits');

// Exact failed shape: system, query, call, 32k page, call, 32k page.
const browserPages = [{ role: 'system', content: 'Browser instructions. ' + 's'.repeat(2500) },
    { role: 'user', content: 'Find The Odyssey in IMAX 70mm in Dublin, CA. ' + 'Research findings. '.repeat(30) }];
for (let i = 0; i < 2; i++) browserPages.push(
    { role: 'assistant', content: '', tool_calls: [{ id: 'page-' + i, function: { name: 'read_url', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'page-' + i, content: 'Synthetic browser page. ' + 'p'.repeat(31950) });
const twoPageRequest = { messages: structuredClone(browserPages) };
assert.equal(twoPageRequest.messages.length, 6);
clamp(twoPageRequest);
assert.deepEqual(twoPageRequest.messages.map(m => m.role), ['system', 'user', 'assistant', 'tool']);
assert.deepEqual(twoPageRequest.messages[1], browserPages[1]);
assertPaired(twoPageRequest.messages);

// A captured image and a tools-free synthesis request are attached to the
// newest exchange; they must not cause that exchange to be split or dropped.
const image = { role: 'user', content: [{ type: 'text', text: 'Tool screenshot' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,c3ludGhldGlj' } }] };
const synthesis = { role: 'user', content: 'Research is over. Write the findings from the evidence above.' };
for (const suffix of [[image], [synthesis], [image, synthesis]]) {
    const input = [...structuredClone(research), ...suffix];
    const request = { messages: input };
    const original = structuredClone(input);
    clamp(request);
    assertPaired(request.messages);
    assert.deepEqual(request.messages.find(m => m.role === 'user'), research[1], 'Images/synthesis cannot stand in for the original assignment');
    assert.ok(request.messages.some(m => m.tool_call_id === 'toolu_research_4_0'));
    assert.deepEqual(request.messages.slice(-suffix.length), suffix);
    assert.deepEqual(input, original, 'Trimming cannot mutate the working history');
}

// Browser can cross the cap after just two 32k page observations. The active
// assignment (including handed-off findings) must precede retained tool work.
const browserGoal = { role: 'user', content: 'Find The Odyssey, Dublin CA, IMAX 70mm. Research findings: ' + 'r'.repeat(28000) + '\nDo not reserve seats.' };
const browserHistory = [{ role: 'system', content: 'Browser instructions.' }, browserGoal, ...exchange('browser-large', 32000)];
const browserRequest = { messages: structuredClone(browserHistory) };
clamp(browserRequest);
assert.deepEqual(browserRequest.messages[1], browserGoal, 'Shorten page results before the current query');
assert.ok(textSize(browserRequest.messages) <= LIMIT);
assertPaired(browserRequest.messages);

// Old conversations may be discarded, but the latest independent user turn
// owns the active loop. Do not resurrect the previous request instead.
const updated = { messages: [{ role: 'user', content: 'Old request' }, { role: 'assistant', content: 'Old answer' },
    ...structuredClone(research)] };
clamp(updated);
assert.equal(updated.messages.some(m => m.content === 'Old request'), false);
assert.deepEqual(updated.messages.find(m => m.role === 'user'), research[1]);

// A queued correction rides a tool exchange. Protect that exchange too, so
// later observations cannot erase a change of venue/date from the user.
const correction = { role: 'user', content: 'Use September 23 instead of September 19.' };
const corrected = { messages: [research[0], research[1], ...exchange('early', 16000), correction,
    ...exchange('later', 16000), ...exchange('latest', 16000)] };
clamp(corrected);
assert.ok(corrected.messages.includes(correction));
assert.deepEqual(corrected.messages.find(m => m.role === 'user'), research[1]);
assert.ok(textSize(corrected.messages) <= LIMIT);
assertPaired(corrected.messages);

// The query may itself be multimodal; retain its text and pixels verbatim.
const visualQuery = { role: 'user', content: [{ type: 'text', text: 'Inspect this layout for Dublin, CA.' }, ...image.content.slice(1)] };
const visualRequest = { messages: [research[0], visualQuery, ...research.slice(2)] };
clamp(visualRequest);
assert.deepEqual(visualRequest.messages.find(m => m.role === 'user'), visualQuery);
assertPaired(visualRequest.messages);

// Oversized final batches retain EVERY result, with a marker on shortened
// text. Raw signed thinking/tool_use blocks and arguments are unchanged.
for (const nativeBlocks of [true, false]) {
    const batch = exchange('large', 35000);
    if (!nativeBlocks) delete batch[0]._anthropicContent;
    const messages = [{ role: 'system', content: 'The system instructions stay intact.' }, ...batch, image, synthesis];
    const original = structuredClone(messages);
    const request = { messages };
    clamp(request);
    assertPaired(request.messages);
    assert.ok(textSize(request.messages) <= LIMIT, 'The marker counts toward the text limit');
    assert.equal(request.messages.filter(m => m.role === 'tool').length, 2);
    assert.ok(request.messages.some(m => m.role === 'tool' && m.content.includes('[trimmed before sending off this Mac]')));
    assert.deepEqual(request.messages.find(m => m.role === 'assistant'), original[1], 'Call metadata/signatures survive verbatim');
    assert.deepEqual(messages, original, 'Even shortened results leave the caller history untouched');
    const once = structuredClone(request.messages);
    clamp(request);
    assert.deepEqual(plain(request.messages), once, 'Clamping is idempotent');
}

// Also respect native replay when only _anthropicContent describes the calls.
const rawOnly = structuredClone(research);
for (const message of rawOnly) delete message.tool_calls;
const rawRequest = { messages: rawOnly };
clamp(rawRequest);
assertPaired(rawRequest.messages);

// Plain prompts still trim oldest-first and preserve system messages. The
// latest user text gets an honest marker when that alone is too large.
const plainRequest = { messages: [{ role: 'system', content: 'System instructions' },
    { role: 'user', content: 'o'.repeat(30000) }, { role: 'assistant', content: 'p'.repeat(10000) },
    { role: 'system', content: 'Additional instructions' }, { role: 'user', content: 'n'.repeat(30000) }] };
clamp(plainRequest);
assert.deepEqual(plainRequest.messages.map(m => m.content[0]), ['S', 'p', 'A', 'n']);
const longUser = { messages: [{ role: 'system', content: 'Keep this' }, { role: 'user', content: 'x'.repeat(60000) }] };
const userHistory = longUser.messages;
const originalUser = structuredClone(longUser.messages);
clamp(longUser);
assert.equal(textSize(longUser.messages), LIMIT);
assert.ok(longUser.messages.at(-1).content.endsWith('[trimmed before sending off this Mac]'));
assert.deepEqual(userHistory, originalUser, 'The caller keeps the full user message');

// A system instruction between a call and its result is hoisted by the
// provider. It cannot split an otherwise valid tool exchange during trimming.
const withSystem = structuredClone(research);
withSystem.splice(3, 0, { role: 'system', content: 'Additional immutable instructions' });
const systemRequest = { messages: withSystem };
clamp(systemRequest);
assertPaired(systemRequest.messages);
assert.equal(systemRequest.messages.filter(m => m.role === 'system').length, 2);

// Short and exactly-at-limit requests are untouched, including array identity.
for (const messages of [[], exchange('short', 10), [{ role: 'user', content: 'x'.repeat(LIMIT) }]]) {
    const request = { messages };
    clamp(request);
    assert.equal(request.messages, messages);
    assert.equal(request._clamped, undefined);
}
clamp({});
clamp(null);
const oversizedSystem = { messages: [{ role: 'system', content: 's'.repeat(LIMIT + 1) }, ...exchange('system', 10)] };
clamp(oversizedSystem);
assertPaired(oversizedSystem.messages);
assert.equal(oversizedSystem.messages[0].content.length, LIMIT + 1, 'Immutable system instructions remain exempt');

console.log('Cloud prompt: initiating query, queued corrections, complete tool exchanges, synthesis/images, signed replay, text limits and immutable history passed');

// Optional: exercise the configured llama-server's actual Jinja template.
// No inference, personal data, browser actions or model/settings changes.
const serverAt = process.argv.indexOf('--server-url');
if (serverAt >= 0) (async () => {
    const url = new URL(process.argv[serverAt + 1]);
    assert.ok(/^https?:$/.test(url.protocol) && !url.username && !url.password && !url.search && !url.hash);
    url.pathname = '/apply-template';
    const tools = [{ type: 'function', function: { name: 'read_url', description: 'Read a synthetic fixture page', parameters: { type: 'object', properties: { url: { type: 'string' } } } } }];
    const apply = async messages => {
        const wire = messages.map(({ _anthropicContent, ...m }) => ({ ...m, ...(m.tool_calls ? { tool_calls: m.tool_calls.map(tc => ({ ...tc, type: 'function' })) } : {}) }));
        const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ messages: wire, tools }), signal: AbortSignal.timeout(15000) });
        return { status: response.status, text: await response.text() };
    };
    const broken = await apply(params.messages.filter(m => m.role !== 'user'));
    assert.equal(broken.status, 500);
    assert.match(broken.text, /No user query found in messages/);
    for (const request of [params, twoPageRequest, browserRequest, corrected]) {
        const response = await apply(request.messages);
        assert.equal(response.status, 200, 'The model template accepts reduced tool history with its query intact');
        assert.ok(JSON.parse(response.text).prompt.includes(request.messages.find(m => m.role === 'user').content.trim()));
    }
    console.log('Live local template: reproduced missing-query error; all 4 reduced histories accepted');
})().catch(error => { console.error(error); process.exitCode = 1; });
