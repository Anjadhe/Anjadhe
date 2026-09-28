// The Mac half of one conversation list (docs/MOBILE_NATIVE.md "M5"):
// AgentService's ONE save funnel stamps a conversation that changed and
// tombstones one that left; editing the last message records what it cut;
// and a conversation merged in from the phone or another Mac reaches memory.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const store = {};
const local = {};
const keyListeners = [];
Object.assign(globalThis, {
    window: globalThis,
    localStorage: { getItem: (k) => (k in local ? local[k] : null), setItem: (k, v) => { local[k] = String(v); }, removeItem: (k) => { delete local[k]; } },
    StorageManager: { get: (k) => (store[k] ? JSON.parse(JSON.stringify(store[k])) : null), set: (k, v) => { store[k] = JSON.parse(JSON.stringify(v)); }, invalidate() {} },
    PrivateChat: { persistable: (l) => l.filter(c => !c.private), isPrivate: (c) => !!(c && c.private) },
    electronStore: { onKeyChanged: (cb) => keyListeners.push(cb) },
    AgentUI: { renderHistorySidebar() { globalThis.__redrawn = (globalThis.__redrawn || 0) + 1; }, renderMessages() {} },
});
const src = fs.readFileSync(path.join(__dirname, '../js/agent/agent-service.js'), 'utf8').replace(/^const AgentService =/m, 'globalThis.AgentService =');
(0, eval)(src);
const S = AgentService;
S._storageKey = 'agent-conversations'; S._terminalStorageKey = 'agent-terminal';
S._streamingState = new Map();

const old = '2026-01-01T00:00:00.000Z';
store['agent-conversations'] = { activeConversationId: 'legacy', conversations: [
    { id: 'c1', title: 'One', createdAt: old, updatedAt: old, messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }] },
    { id: 'c2', title: 'Two', createdAt: old, updatedAt: old, messages: [{ role: 'user', content: 'x' }] },
] };
S.loadConversations();
assert.strictEqual(S.activeConversationId, 'legacy', 'the synced active id is read once, for old installs');

// Saving with nothing changed stamps nothing.
S._saveConversations();
assert.ok(store['agent-conversations'].conversations.every(c => c.updatedAt === old));
assert.strictEqual(local['agent-active-conversation'], 'legacy');
assert.strictEqual(store['agent-conversations'].activeConversationId, undefined, 'the active id no longer syncs');

// A change stamps only that conversation.
S.conversations.find(c => c.id === 'c1').messages.push({ role: 'user', content: 'more' });
S._saveConversations();
const saved = Object.fromEntries(store['agent-conversations'].conversations.map(c => [c.id, c]));
assert.notStrictEqual(saved.c1.updatedAt, old);
assert.strictEqual(saved.c2.updatedAt, old);

// A removal (any path) leaves a tombstone.
S.conversations = S.conversations.filter(c => c.id !== 'c2');
S._saveConversations();
assert.ok(store['agent-conversations'].tombstones.c2);

// Editing the last message records the cut keys (main's identity).
S.conversations.find(c => c.id === 'c1').messages.push({ role: 'assistant', content: 'answer' });
assert.strictEqual(S.editLastUserMessage('c1'), 'more');
const c1 = S.conversations.find(c => c.id === 'c1');
assert.deepStrictEqual(c1.removedMessages, ['user\u0000more\u00001', 'assistant\u0000answer\u00001']);

// A private chat is never stamped, stored or tombstoned.
S.conversations.push({ id: 'p1', private: true, createdAt: old, messages: [] });
S._saveConversations();
S.conversations = S.conversations.filter(c => c.id !== 'p1');
S._saveConversations();
assert.ok(!store['agent-conversations'].conversations.some(c => c.id === 'p1'));
assert.ok(!(store['agent-conversations'].tombstones || {}).p1);

// A conversation merged into the store from the phone reaches memory, and a
// newer copy of one this window holds replaces it; its own save changes nothing.
const now = new Date().toISOString();
store['agent-conversations'].conversations.push({ id: 'c3', title: 'Phone: plan', channel: 'mobile', createdAt: now, updatedAt: now, messages: [{ role: 'user', content: 'plan' }] });
const c1stored = store['agent-conversations'].conversations.find(c => c.id === 'c1');
c1stored.messages = [...c1.messages, { role: 'user', content: 'from phone' }];
c1stored.updatedAt = new Date(Date.now() + 1000).toISOString();
assert.strictEqual(S.mergeStoredConversations(), true);
assert.ok(S.conversations.some(c => c.id === 'c3'));
assert.strictEqual(S.conversations.find(c => c.id === 'c1').messages.at(-1).content, 'from phone');
assert.ok(globalThis.__redrawn >= 1);
const before = JSON.stringify(store['agent-conversations']);
S._saveConversations();
const after = store['agent-conversations'];
assert.strictEqual(after.conversations.find(c => c.id === 'c3').updatedAt, now, 'a merged-in conversation is not re-stamped');
assert.ok(!(after.tombstones || {}).c3);
assert.strictEqual(S.mergeStoredConversations(), false, 'nothing newer the second time');
void before;

console.log('conversation-save-test: ok');
