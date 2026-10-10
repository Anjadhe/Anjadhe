#!/usr/bin/env node
/**
 * Existing routines becoming instructions (docs/ROUTINES_UX.md step 5,
 * js/core/routine-convert.js): the checks on a proposal, the cards, and
 * accept / undo / decline over the real routine store (CV1–CV4).
 */
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
global.document = new JSDOM('<body></body>').window.document;
const store = {};
global.StorageManager = { get: k => (store[k] === undefined ? null : JSON.parse(JSON.stringify(store[k]))), set: (k, v) => { store[k] = JSON.parse(JSON.stringify(v)); } };
global.AgentService = { conversations: [], activeConversationId: null, _saveConversations() {} };
let n = 0;
global.UIUtils = { generateId: () => `id${++n}` };
const ls = new Map();
global.localStorage = { getItem: k => (ls.has(k) ? ls.get(k) : null), setItem: (k, v) => ls.set(k, String(v)), removeItem: k => ls.delete(k) };
const NP = require('../js/apps/notes/note-prompts.js');
global.NotePrompts = NP;
const RC = require('../js/core/routine-convert.js');

const visa = NP.create({ title: 'Latest Visa Bulletin Dates', body: 'Look up the latest US Visa Bulletin and report the EB-2 and EB-3 dates for India in a table.', config: { offline: true, interval: 'daily', time: '08:00', useContext: true } });
const uspto = NP.create({ title: 'USPTO trademark mail watch', body: 'When an email from the USPTO about my trademark arrives, summarize it and the deadline.', config: { offline: true, trigger: { type: 'email', from: 'uspto.gov' } } });
const task = NP.create({ title: 'File receipts', body: 'File each receipt as a task.', config: { offline: true, runMode: 'task', interval: 'daily', time: '09:00' } });
const done = NP.create({ title: 'Quantum', body: 'A roundup.', config: { offline: true, interval: 'daily', time: '07:00', tells: 'each', saysBack: 'bring you a roundup' } });
const unarmed = NP.create({ title: 'Saved prompt', body: 'Something on request.', config: { offline: false } });
const routines = RC._routines();

// ── Candidates: armed, telling, made before the set-up said them back ──
assert.deepEqual(RC.candidates(routines).map(r => r.id).sort(), [visa.id, uspto.id].sort(), 'not a task, not one already said back, not one that is not armed');

// ── The checks on a proposal (CV4) ──
const v = routines.find(r => r.id === visa.id);
assert.deepEqual(RC.vet({ watcher: null, tells: 'change', says_back: "I'll check the visa bulletin and tell you only when the EB-2 or EB-3 dates change." }, v, { mail: true, money: true }),
    { watcher: null, tells: 'change', saysBack: 'check the visa bulletin and tell you only when the EB-2 or EB-3 dates change' });
assert.equal(RC.vet({ watcher: null, tells: 'change', says_back: 'tell you when EB-2 moves 30 days' }, v, {}), null, 'a number the routine never said is refused');
assert.equal(RC.vet({ watcher: null, tells: 'sometimes', says_back: 'x' }, v, {}), null, 'tells must be change or each');
assert.equal(RC.vet({ watcher: 'mail', says_back: 'tell you right away' }, v, { mail: false }), null, 'no mail connected: no mail instruction (and no tells to fall back on)');
assert.equal(RC.vet({ watcher: 'money', tells: 'change', says_back: 'watch it' }, v, { money: false }).watcher, null, 'no money connected: a routine of its own');
const u = routines.find(r => r.id === uspto.id);
assert.deepEqual(RC.vet({ watcher: 'mail', tells: 'each', says_back: 'tell you right away when the USPTO writes' }, u, { mail: true }),
    { watcher: 'mail', tells: null, saysBack: 'tell you right away when the USPTO writes' }, 'a mail instruction has no watch/delivery choice');

// ── applied (CV3): the time is kept; only a mail instruction drops its email trigger ──
assert.deepEqual(RC.applied(v.cfg, { watcher: null, tells: 'change', saysBack: 'x' }), { watcher: null, tells: 'change', saysBack: 'x' });
assert.deepEqual(RC.applied(u.cfg, { watcher: 'mail', tells: null, saysBack: 'x' }).trigger, { type: 'time', interval: 'daily', time: null });

// ── Cards, accept with a backup, undo, decline (CV1, CV2) ──
const fp = r => RC.fingerprint({ title: r.title, body: r.body, trigger: r.cfg.trigger });
RC.save({ proposals: {
    [visa.id]: { fp: fp(v), proposal: { watcher: null, tells: 'change', saysBack: 'check the visa bulletin and tell you only when the EB-2 or EB-3 dates change' } },
    [uspto.id]: { fp: fp(u), proposal: { watcher: 'mail', tells: null, saysBack: 'tell you right away when the USPTO writes about your trademark' } }
}, answered: {}, triedAt: Date.now() });
let cards = RC.today();
assert.equal(cards.length, 2);
const vc = cards.find(c => c.routineId === visa.id);
assert.equal(vc.title, 'Should “Latest Visa Bulletin Dates” work like this?');
assert.equal(vc.body, 'Every day at 8:00 AM, I’ll check the visa bulletin and tell you only when the EB-2 or EB-3 dates change.', 'the card says the routine back, with its own time');
assert.equal(cards.find(c => c.routineId === uspto.id).body, 'As your mail and texts arrive, I’ll tell you right away when the USPTO writes about your trademark.');
assert.equal(NP.config(NP.get(visa.id)).tells, null, 'nothing changed without a tap (CV1)');

assert.equal(RC.accept(visa.id), true);
const after = NP.config(NP.get(visa.id));
assert.deepEqual([after.tells, after.watcher, after.time, after.interval, after.useContext], ['change', null, '08:00', 'daily', true], 'it keeps its time and its sources');
assert.equal(StorageManager.get(RC.BACKUP_KEY).routines.length, 5, 'every routine backed up before the first change (CV2)');
assert.equal(RC.today().some(c => c.routineId === visa.id), false, 'answered, so no card');

assert.equal(RC.accept(uspto.id), true);
const ua = NP.config(NP.get(uspto.id));
assert.deepEqual([ua.watcher, ua.trigger.type], ['mail', 'time'], 'the mail instruction is read as mail arrives');
assert.equal(RC.undo(uspto.id), true);
const ub = NP.config(NP.get(uspto.id));
assert.deepEqual([ub.watcher, ub.trigger.type, ub.trigger.from, ub.saysBack], [null, 'email', 'uspto.gov', null], 'Undo puts it back as it was');

assert.equal(RC.today().length, 0, 'undone is kept as it is: not asked again');
assert.equal(NP.config(NP.get(task.id)).watcher, null);
void done; void unarmed;
console.log('routine-convert: candidates, checks, cards, accept with backup, undo and decline passed');
