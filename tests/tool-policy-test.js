// The run's tool policy holds where the tool runs, not only in the list the
// model is shown (the architecture review, 2026-10-12): a name the turn did
// not offer, a blocked tool in an untrusted run and a write in a read-only
// run are refused by AgentTools.execute before the handler runs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const remembered = [];
const ctx = vm.createContext({
    console, setTimeout: () => 1, clearTimeout() {},
    localStorage: { getItem: () => null },
    StorageManager: { get: () => null, set() {} },
    MemoryManager: { remember(o) { remembered.push(o); return { fact: { id: 'f1', text: o.text }, status: 'new' }; } },
    window: {}
});
for (const [file, name] of [
    ['js/shared/chat-prompt.js', 'ChatPrompt'],
    ['js/agent/agent-tools.js', 'AgentTools'],
    ['js/agent/agent-service.js', 'AgentService']
]) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8') + `\nthis.${name} = ${name};`, ctx);
const { AgentTools: T, AgentService: S } = ctx;

(async () => {
    const fact = { text: 'Likes tea', heading: 'about' };
    // Untrusted: a blocked tool is refused even though its handler exists.
    let r = await T.execute('save_memory', fact, { untrusted: true });
    assert.equal(r.denied, true); assert.equal(remembered.length, 0);
    // Read-only: a write is refused.
    r = await T.execute('save_memory', fact, { readOnly: true });
    assert.equal(r.denied, true); assert.equal(remembered.length, 0);
    // Not offered: refused whatever the tool.
    r = await T.execute('save_memory', fact, { offered: new Set(['think']) });
    assert.equal(r.denied, true); assert.equal(remembered.length, 0);
    // Offered, trusted, writable: runs, and files the fact under the RUN's chat.
    S.activeConversationId = 'on-screen';
    r = await T.execute('save_memory', fact, { convId: 'routine-chat', offered: new Set(['save_memory']) });
    assert.equal(r.success, true);
    assert.equal(remembered[0].convId, 'routine-chat', 'the run\'s own chat, never the one on screen');
    // Reads still run in a read-only, untrusted run when not blocked.
    r = await T.execute('think', { thought: 'x' }, { readOnly: true, untrusted: true });
    assert.equal(r.denied, undefined);

    // The chat loop's refusal names use_tools only when loading would offer it.
    const def = n => ({ function: { name: n } });
    T._toolGroups.fake_loadable = 'fakegroup';
    T.handlers.fake_loadable = () => ({});
    const hint = S._notOfferedResult('fake_loadable', extra => extra.includes('fakegroup') ? [def('fake_loadable')] : []);
    assert.match(hint.error, /use_tools/); assert.equal(hint.denied, undefined);
    const withheld = S._notOfferedResult('fake_loadable', () => []);
    assert.equal(withheld.denied, true); assert.doesNotMatch(withheld.error, /use_tools/);
    assert.equal(S._notOfferedResult('no_such_tool', () => []).denied, true);
    console.log('tool-policy: hidden tools are refused where they run');
})().catch(e => { console.error(e); process.exit(1); });
