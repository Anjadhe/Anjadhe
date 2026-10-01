// Pins js/agent/private-chat.js — the laws of a private assistant chat.
const assert = require('assert');
const PrivateChat = require('../js/agent/private-chat.js');

// create: private, titled, personal info off unless asked
const off = PrivateChat.create();
assert.strictEqual(off.private, true);
assert.strictEqual(off.title, 'Private chat');
assert.strictEqual(off.contextMode, 'simple');
assert.deepStrictEqual(off.messages, []);
assert.ok(off.id.startsWith('private_'));
const on = PrivateChat.create({ usePersonalInfo: true });
assert.strictEqual(on.contextMode, undefined);
assert.notStrictEqual(off.id, on.id);

// P1: persistable drops private chats and nothing else
const saved = { id: 'a', messages: [] };
const terminal = { id: 't', cliTerminal: true, messages: [] };
assert.deepStrictEqual(PrivateChat.persistable([saved, off, terminal, null]), [saved, terminal]);
assert.deepStrictEqual(PrivateChat.persistable(undefined), []);
assert.strictEqual(PrivateChat.isPrivate(off), true);
assert.strictEqual(PrivateChat.isPrivate({ private: 'yes' }), false);
assert.strictEqual(PrivateChat.isPrivate(null), false);

// P3: memory writes and task runs are refused; reads and actions are not
for (const t of ['save_memory', 'update_memory', 'start_task']) {
    assert.strictEqual(PrivateChat.isBlockedTool(t), true, t);
    assert.ok(/private chat/.test(PrivateChat.blockedResult(t).error), t);
}
for (const t of ['recall_memory', 'search_memories', 'create_schedule_item', 'web_search', 'delete_memory']) {
    assert.strictEqual(PrivateChat.isBlockedTool(t), false, t);
}

// P4: redaction keeps the numbers and the destination, drops the words
const entry = {
    source: 'agent', subject: 'Something personal', left: true, destination: 'OpenAI (your key)',
    systemPrompt: 'sys', userPrompt: 'my secret', response: 'the answer',
    requestMessages: [{ role: 'user', chars: 9, preview: 'my secret', toolCalls: 0 }],
    toolCalls: [{ name: 'web_search', args: '{"query":"my secret"}' }],
    promptTokens: 12, completionTokens: 5, durationMs: 300
};
PrivateChat.redactEntry(entry);
const json = JSON.stringify(entry);
assert.ok(!json.includes('my secret') && !json.includes('the answer') && !json.includes('Something personal'), json);
assert.strictEqual(entry.privateChat, true);
assert.strictEqual(entry.left, true);
assert.strictEqual(entry.destination, 'OpenAI (your key)');
assert.strictEqual(entry.promptTokens, 12);
assert.strictEqual(entry.requestMessages[0].chars, 9);
assert.strictEqual(entry.toolCalls[0].name, 'web_search');
assert.strictEqual(entry.response, PrivateChat.REDACTED);
// an entry that errored before a response stays null, not a fake string
const errored = PrivateChat.redactEntry({ userPrompt: 'x', response: null });
assert.strictEqual(errored.response, null);

console.log('private-chat-test: ok');
