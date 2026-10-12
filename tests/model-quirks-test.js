// ModelQuirks.stripLeakedToolCalls — a tool call written as text never
// reaches a chat bubble or a routine post (a routine once posted a bare
// <tool_call><function=read_url>… from its tools-free synthesis pass).
const assert = require('assert');
const ModelQuirks = require('../js/agent/model-quirks.js');
const strip = ModelQuirks.stripLeakedToolCalls;

// The live repro: Qwen3-Coder syntax inside <tool_call>, nothing else.
const repro = `<tool_call>
<function=read_url>
<parameter=find>
DATES FOR FILING Chart 2 All China India Mexico Philippines EB
</parameter>
<parameter=url>
https://www.andhrafriends.com/topic/1102590-october-visa-bulletin-released/
</parameter>
</function>
</tool_call>`;
assert.deepStrictEqual(strip(repro), { text: '', leaked: true });

// Hermes/Qwen JSON form, with prose around it: the prose survives.
const mixed = 'Here is the summary.\n\n<tool_call>\n{"name":"read_url","arguments":{"url":"https://x"}}\n</tool_call>\n\nMore below.';
assert.deepStrictEqual(strip(mixed), { text: 'Here is the summary.\n\nMore below.', leaked: true });

// Unterminated block runs to the end.
assert.deepStrictEqual(strip('Answer.\n<function=web_search>\n<parameter=q>'), { text: 'Answer.', leaked: true });

// Bare <function=…> without the wrapper.
assert.strictEqual(strip('<function=read_url><parameter=url>https://x</parameter></function>').text, '');

// Ordinary prose is untouched, including talk ABOUT functions.
const prose = 'The function returns a list; call it with a url.';
assert.deepStrictEqual(strip(prose), { text: prose, leaked: false });
assert.deepStrictEqual(strip(''), { text: '', leaked: false });

console.log('model-quirks-test: ok');
