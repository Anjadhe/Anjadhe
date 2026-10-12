// Pins js/agent/memory-transfer.js and MemoryManager.importFacts: an
// untouched export comes back exactly; anything else is READ by the model,
// and code keeps only facts whose quote is in the file (X1); an edited
// export keeps stars/subjects/dates for unchanged lines (X4).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const mmSrc = fs.readFileSync(path.join(__dirname, '../js/agent/memory-manager.js'), 'utf8');
const mtSrc = fs.readFileSync(path.join(__dirname, '../js/agent/memory-transfer.js'), 'utf8');

function load(store = { memory: { facts: [], seeded: { email: true } } }, llm = null) {
    const ctx = {
        console, Map, Set, JSON, Date, RegExp,
        localStorage: { getItem: () => '1', setItem() {}, removeItem() {} },
        StorageManager: {
            get: k => (store[k] === undefined ? null : JSON.parse(JSON.stringify(store[k]))),
            set: (k, v) => { store[k] = JSON.parse(JSON.stringify(v)); },
            clear: k => { delete store[k]; }
        },
        AgentService: { model: 'm', numCtx: 8192 },
        LLMLogger: { calls: [], async call(src, p) { this.calls.push(p); return llm ? llm(p) : { error: 'no model' }; } },
        UIUtils: { escapeHtml: s => String(s), showToast() {}, confirm: async () => true },
        window: {}
    };
    vm.createContext(ctx);
    vm.runInContext(mmSrc + '\n' + mtSrc + '\nthis.MemoryManager = MemoryManager; this.MemoryTransfer = MemoryTransfer;', ctx);
    ctx.MemoryManager.init();
    return ctx;
}

(async () => {
    // 1. Round trip: export, erase (a fresh store), import — exact, no model call.
    {
        const a = load();
        const mm = a.MemoryManager;
        mm.remember({ text: 'Lives in Austin', heading: 'about', subject: 'home' });
        const kid = mm.remember({ text: 'Daughter Maya is 9', heading: 'people', subject: 'maya' }).fact;
        mm.edit(kid.id, { starred: true });
        mm.remember({ text: 'Practices piano on Tuesdays', heading: 'Music', newPage: true });
        const text = a.MemoryTransfer.exportText(new Date('2026-10-11T12:00:00Z'));
        assert.match(text, /## People\n\n- Daughter Maya is 9 \(always remember\)/);
        assert.match(text, /## Music/);
        assert.match(text, /```nenva-memory/);

        const b = load({});   // a fresh install: the email defaults seed
        const plan = await b.MemoryTransfer.plan(text);
        assert.equal(plan.mode, 'exact');
        assert.equal(b.LLMLogger.calls.length, 0, 'an untouched export needs no model');
        const before = b.MemoryManager.all().length;
        const res = b.MemoryTransfer.apply(plan);
        assert.equal(res.added.length, 3, 'the three facts; the email defaults were already there');
        assert.equal(b.MemoryManager.all().length, before + 3);
        const maya = b.MemoryManager.all().find(f => f.text === 'Daughter Maya is 9');
        assert.equal(maya.starred, true);
        assert.equal(maya.subject, 'maya');
        assert.equal(maya.heading, 'people');
        assert.equal(maya.createdAt, kid.createdAt, 'dates come back');
        const piano = b.MemoryManager.all().find(f => f.text.startsWith('Practices piano'));
        assert.equal(b.MemoryManager.headingLabel(piano.heading), 'Music', 'a custom page comes back with its label');

        // Importing again changes nothing (X3).
        const again = b.MemoryTransfer.apply(await b.MemoryTransfer.plan(text));
        assert.equal(again.added.length, 0);
        // Undo takes back what was added.
        assert.equal(b.MemoryManager.forgetMany(res.added), 3);
    }

    // 2. An edited export is READ (X4), and unchanged lines keep their metadata.
    {
        const a = load();
        const k = a.MemoryManager.remember({ text: 'Daughter Maya is 9', heading: 'people', subject: 'maya' }).fact;
        a.MemoryManager.edit(k.id, { starred: true });
        const edited = a.MemoryTransfer.exportText().replace('## People\n\n', '## People\n\n- Son Arjun plays soccer\n');
        const b = load({}, () => ({ message: { content: JSON.stringify({ facts: [
            { text: 'Son Arjun plays soccer', page: 'People', quote: 'Son Arjun plays soccer' },
            { text: 'Daughter Maya is 9', page: 'People', quote: 'Daughter Maya is 9' },
            { text: 'Loves sushi', page: 'Preferences', quote: 'loves sushi more than anything' }
        ] }) } }));
        const plan = await b.MemoryTransfer.plan(edited);
        assert.equal(plan.mode, 'read');
        assert.equal(b.LLMLogger.calls.length, 1);
        assert.ok(!b.LLMLogger.calls[0].messages[1].content.includes('nenva-memory'), 'the data block is not shown to the model');
        assert.equal(plan.dropped, 1, 'X1: a quote not in the file is dropped');
        assert.equal(JSON.stringify(plan.facts.map(f => f.text)), JSON.stringify(['Son Arjun plays soccer', 'Daughter Maya is 9']));
        const maya = plan.facts.find(f => f.text.startsWith('Daughter'));
        assert.equal(maya.starred, true);
        assert.equal(maya.subject, 'maya');
        const res = b.MemoryTransfer.apply(plan);
        assert.equal(res.added.length, 2);
        assert.equal(b.MemoryManager.all().find(f => f.text.startsWith('Son')).heading, 'people');
    }

    // 3. Another assistant's export: read, a new page made from the model's name.
    {
        const other = 'Here is what I know about you:\n* You work as a nurse at St. Mary\'s.\n* You are training for a half marathon in March.\n';
        const b = load(undefined, () => ({ message: { content: '```json\n' + JSON.stringify({ facts: [
            { text: 'Works as a nurse at St. Mary\'s', page: 'work', quote: 'You work as a nurse at St. Mary\'s.' },
            { text: 'Training for a half marathon in March', page: 'Running', quote: 'training for a half   marathon in March' }
        ] }) + '\n```' } }));
        const plan = await b.MemoryTransfer.plan(other);
        assert.equal(plan.facts.length, 2, 'whitespace and case differences in a quote still match');
        b.MemoryTransfer.apply(plan);
        const run = b.MemoryManager.all().find(f => f.text.startsWith('Training'));
        assert.equal(b.MemoryManager.headingLabel(run.heading), 'Running');
        assert.equal(b.MemoryManager.all().find(f => f.text.startsWith('Works')).heading, 'work');
        assert.equal(run.source, 'import');
    }

    // 4. Same page + subject keeps the later one (X3 / M2).
    {
        const b = load();
        b.MemoryManager.remember({ text: 'Works at Acme', heading: 'work', subject: 'employer' });
        const res = b.MemoryManager.importFacts([{ text: 'Works at Globex', heading: 'work', subject: 'employer', updatedAt: '2001-01-01T00:00:00Z' }]);
        assert.equal(res.already, 1, 'an older import does not overwrite a newer fact');
        const res2 = b.MemoryManager.importFacts([{ text: 'Works at Initech', heading: 'work', subject: 'employer', updatedAt: '2099-01-01T00:00:00Z' }]);
        assert.equal(res2.replaced, 1);
        assert.ok(b.MemoryManager.all().some(f => f.text === 'Works at Initech'));
    }

    // 5. No model and no data block: an error, nothing written.
    {
        const b = load();
        const plan = await b.MemoryTransfer.plan('- Something about me');
        assert.ok(plan.error);
        assert.ok((await b.MemoryTransfer.plan('   ')).error);
    }

    console.log('memory-transfer-test: all passed');
})().catch(e => { console.error(e); process.exit(1); });
