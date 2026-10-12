// ChatDays: a chat continued on a later day names the day each earlier part
// was said on, so "tomorrow" in yesterday's message is not read as tomorrow.
const assert = require('assert');
const ChatDays = require('../js/agent/chat-days.js');

const at = (d, h = 10) => new Date(`${d}T${String(h).padStart(2, '0')}:00:00`).toISOString();
const now = Date.parse(at('2026-10-05', 12));

// The reported chat: moved "tomorrow" on the 4th, continued on the 5th.
{
    const stored = [
        { role: 'user', content: 'will do it tomorrow morning 9 am', timestamp: at('2026-10-04', 23) },
        { role: 'assistant', content: 'Moved. It now sits tomorrow morning at 9:00 AM.', timestamp: at('2026-10-04', 23) },
        { role: 'user', content: 'will do this tomorrow morning', timestamp: at('2026-10-05', 12) }
    ];
    const out = ChatDays.mark(stored, stored.map(m => ({ role: m.role, content: m.content })), { now });
    assert.ok(out[0].content.includes('Sunday, October 4, 2026'), 'the earlier day is named');
    assert.ok(out[0].content.endsWith('will do it tomorrow morning 9 am'), 'the words are kept whole');
    assert.strictEqual(out[1].content, stored[1].content, 'assistant messages are never marked');
    assert.strictEqual(out[2].content, stored[2].content, "today's message gets no line");
    assert.strictEqual(stored[0].content, 'will do it tomorrow morning 9 am', 'the stored message is untouched');
}

// One line per day, not per message.
{
    const stored = [
        { role: 'user', content: 'a', timestamp: at('2026-10-03', 9) },
        { role: 'user', content: 'b', timestamp: at('2026-10-03', 15) },
        { role: 'user', content: 'c', timestamp: at('2026-10-04', 9) }
    ];
    const out = ChatDays.mark(stored, stored.map(m => ({ ...m })), { now });
    assert.ok(out[0].content.includes('2026-10-03'));
    assert.strictEqual(out[1].content, 'b');
    assert.ok(out[2].content.includes('2026-10-04'));
}

// A chat from before messages were stamped: its start dates the first user message.
{
    const stored = [{ role: 'assistant', content: 'This chat is about X.' }, { role: 'user', content: 'old' }, { role: 'user', content: 'new' }];
    const out = ChatDays.mark(stored, stored.map(m => ({ ...m })), { now, startedAt: at('2026-10-04', 13) });
    assert.ok(out[1].content.includes('2026-10-04'));
    assert.strictEqual(out[2].content, 'new', 'an undated later message is left alone');
    const cut = ChatDays.mark(stored, stored.map(m => ({ ...m })), { now, startedAt: at('2026-10-04', 13), windowStart: 4 });
    assert.strictEqual(cut[1].content, 'old', 'not when the window no longer starts at the beginning');
}

// A same-day chat is byte-identical; content parts keep their images.
{
    const stored = [{ role: 'user', content: 'hi', timestamp: at('2026-10-05', 9) }];
    const llm = [{ role: 'user', content: 'hi' }];
    assert.deepStrictEqual(ChatDays.mark(stored, llm, { now }), llm);
    const parts = [{ role: 'user', content: [{ type: 'text', text: 'see' }, { type: 'image_url', image_url: { url: 'x' } }] }];
    const o = ChatDays.mark([{ role: 'user', content: 'see', timestamp: at('2026-10-01') }], parts, { now });
    assert.strictEqual(o[0].content.length, 3);
    assert.ok(o[0].content[0].text.includes('2026-10-01'));
}

console.log('chat-days-test: ok');
