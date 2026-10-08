// The rebuilt memory store (js/agent/memory-manager.js, 2026-10-01): one
// list of short facts, upkeep by arithmetic (M2), a bounded chat slice (M3),
// and the one-time clearing of the pre-redesign stores.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../js/agent/memory-manager.js'), 'utf8');

// Most checks start with the Email defaults already seeded, so counts are
// about what the test adds; the seeding has its own check below.
function load(store = { memory: { facts: [], seeded: { email: true } } }) {
    const local = {};
    const ctx = {
        console,
        localStorage: { getItem: k => local[k] ?? null, setItem: (k, v) => { local[k] = String(v); }, removeItem: k => { delete local[k]; } },
        StorageManager: {
            get: k => (store[k] === undefined ? null : JSON.parse(JSON.stringify(store[k]))),
            set: (k, v) => { store[k] = JSON.parse(JSON.stringify(v)); },
            clear: k => { delete store[k]; }
        }
    };
    vm.createContext(ctx);
    vm.runInContext(source + '\nthis.MemoryManager = MemoryManager;', ctx);
    return { mm: ctx.MemoryManager, store, local };
}

// Legacy stores are cleared once, and only once.
{
    const { mm, store, local } = load({ 'agent-memories': { memories: [{ id: 'old' }] }, 'agent-memory-profile': { sections: [{ id: 's' }] } });
    mm.init();
    assert.equal(store['agent-memories'], undefined, 'deleted, not overwritten (a merged write would keep the records)');
    assert.equal(store['agent-memory-profile'], undefined);
    assert.equal(local['memory-legacy-cleared'], '1');
    assert.equal(mm.all().filter(f => f.heading !== 'email').length, 0, 'starts from scratch');
    assert.equal(mm.onPage('email').length, mm.EMAIL_DEFAULTS.length, 'with the default email preferences');
}

// Email defaults are seeded once: deleting one does not bring it back.
{
    const { mm, store } = load({});
    mm.init();
    const first = mm.onPage('email');
    assert.ok(first.every(f => f.source === 'default'));
    mm.forget(first[0].id);
    const again = load(store).mm;
    again.init();
    assert.equal(again.onPage('email').length, mm.EMAIL_DEFAULTS.length - 1, 'a deleted default stays deleted');
}

// Pages are open-ended: a new page from a short name, found again by label.
{
    const { mm } = load();
    assert.equal(mm.remember({ text: 'Stray', heading: 'Random words' }).fact.heading, 'about', 'no new page without newPage');
    const f = mm.remember({ text: 'Pickup is at 3:15', heading: "Kids' school", newPage: true }).fact;
    assert.equal(f.heading, 'kids-school');
    assert.equal(mm.headingLabel('kids-school'), "Kids' school");
    assert.equal(mm.headingOf("kids' school"), 'kids-school', 'the same page by its label');
    assert.equal(mm.headingOf('Email'), 'email');
    assert.equal(mm.listPages().map(p => p.id).join(','), 'about,people,work,preferences,plans,email,kids-school');
    // Structured facts: meta rides along, a subject prefix finds them.
    mm.remember({ text: 'Never show email from deals@x.com', heading: 'email', subject: 'mute:deals@x.com', meta: { address: 'deals@x.com' } });
    assert.equal(mm.bySubject('email', 'mute:')[0].meta.address, 'deals@x.com');
    assert.ok(mm.forgetSubject('email', 'mute:deals@x.com'));
    assert.equal(mm.bySubject('email', 'mute:').length, 0);
}

// M2: new → confirmed → updated (by heading + subject) → revert.
{
    const { mm, store } = load();
    const a = mm.remember({ text: 'Works at Initech', heading: 'work', subject: 'Employer', quote: 'I work at Initech' });
    assert.equal(a.status, 'new');
    assert.equal(a.fact.subject, 'employer', 'subjects are lower-cased');
    assert.equal(mm.remember({ text: '  works at initech ', heading: 'about' }).status, 'confirmed', 'same text re-confirms under any heading');
    const b = mm.remember({ text: 'Works at Hooli', heading: 'work', subject: 'employer' });
    assert.equal(b.status, 'updated');
    assert.equal(b.fact.id, a.fact.id);
    assert.equal(b.was, 'Works at Initech');
    assert.equal(mm.all().length, 1);
    assert.equal(mm.revert(a.fact.id).text, 'Works at Initech');
    assert.equal(store.memory.facts.length, 1, 'persisted under the new key');
    assert.equal(mm.remember({ text: '   ' }).error, 'text is required');
    assert.equal(mm.remember({ text: 'Unknown heading lands in About you', heading: 'nope' }).fact.heading, 'about');
}

// Forget / restore and the person's edits.
{
    const { mm } = load();
    const f = mm.remember({ text: 'Vegetarian', heading: 'preferences' }).fact;
    const gone = mm.forget(f.id);
    assert.equal(mm.all().length, 0);
    mm.restore(gone);
    assert.equal(mm.all().length, 1);
    mm.restore(gone);
    assert.equal(mm.all().length, 1, 'restore never duplicates');
    const e = mm.edit(f.id, { text: 'Vegan', starred: true });
    assert.equal(e.text, 'Vegan');
    assert.equal(e.was.text, 'Vegetarian');
    assert.equal(e.starred, true);
    assert.equal(mm.edit(f.id, { text: '  ' }), null, 'an empty edit is refused');
}

// M3: About you + Preferences + starred, within the budget; the rest counted.
{
    const { mm } = load();
    for (let i = 0; i < 60; i++) mm.remember({ text: `About fact ${i} ` + 'x'.repeat(80), heading: 'about' });
    mm.remember({ text: 'Sister is Priya', heading: 'people', subject: 'sister' });
    const starred = mm.remember({ text: 'Runs every morning', heading: 'plans' }).fact;
    mm.edit(starred.id, { starred: true });
    const { always, rest } = mm.forChat();
    const used = always.reduce((n, f) => n + f.text.length + 4, 0);
    assert.ok(used <= mm.CHAT_BUDGET, 'within budget');
    assert.ok(always.some(f => f.id === starred.id), 'a starred fact rides along (newest first)');
    assert.ok(!always.some(f => f.heading === 'people'), 'People is recalled, not carried');
    assert.equal(always.length + rest, mm.all().length);
}

// Search, staleness and the cap.
{
    const { mm } = load();
    mm.remember({ text: 'Sister is Priya, lives in Austin', heading: 'people' });
    mm.remember({ text: 'Allergic to peanuts', heading: 'about' });
    assert.equal(mm.search('priya austin')[0].text, 'Sister is Priya, lives in Austin');
    assert.equal(mm.search('people').length, 1, 'headings are searchable');
    const old = mm.all()[0];
    old.updatedAt = new Date(Date.now() - 200 * 86400000).toISOString();
    assert.ok(mm.isStale(old));
    assert.match(mm.asOfLabel(old), /^as of /);
    assert.equal(mm.needsLook().length, 1);

    const { mm: big } = load();
    const keep = big.remember({ text: 'Keep me', heading: 'about' }).fact;
    big.edit(keep.id, { starred: true });
    keep.updatedAt = '2000-01-01T00:00:00.000Z';
    for (let i = 0; i < big.MAX_FACTS + 5; i++) big.remember({ text: `Fact ${i}`, heading: 'work' });
    assert.equal(big.all().length, big.MAX_FACTS);
    assert.ok(big.get(keep.id), 'starred facts are never evicted');
}

console.log('memory: legacy clear, arithmetic upkeep, forget/restore, chat budget, search, staleness, cap passed');
