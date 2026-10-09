#!/usr/bin/env node
// A read-only run (every routine that uses personal context) keeps the tool
// that LOADS tool groups. Without it the run can reach no group's tools at
// all: groups stopped being seeded from the message's words on 2026-10-02,
// and a strategy review posted "no portfolio or strategy tools available
// this run" on 2026-10-05.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
Object.assign(globalThis, { window: globalThis, localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    StorageManager: { get: () => null, set() {}, invalidate() {} } });
const src = fs.readFileSync(path.join(__dirname, '../js/agent/agent-service.js'), 'utf8').replace(/^const AgentService =/m, 'globalThis.AgentService =');
(0, eval)(src);
const ro = n => AgentService._isReadOnlyTool(n);
assert.equal(ro('use_tools'), true, 'loading a group changes nothing; what it loads is filtered the same way');
for (const n of ['list_portfolio', 'get_strategy', 'search_everything', 'web_search', 'read_url', 'recall_memory', 'think']) assert.equal(ro(n), true, n);
for (const n of ['save_strategy', 'add_transaction', 'create_routine', 'send_text', 'save_goal', '']) assert.equal(ro(n), false, n);
globalThis.AgentTools = { _readOnlyTools: new Set(['check_strategy', 'refresh_portfolio_prices']) };
assert.equal(ro('check_strategy'), true, 'a package flags its own reads');
assert.equal(ro('refresh_portfolio_prices'), true);
console.log('readonly-tools: the group loader survives a read-only run');
