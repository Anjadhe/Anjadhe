/* Taught tasks (js/core/taught-tasks.js, docs/TEACH.md): the recording as
 * the assistant reads it, the facts code keeps on a save, and how a taught
 * task reaches the Browser agent as a playbook. */
const assert = require('node:assert/strict');
globalThis.Playbooks = require('../js/agent/specialists/playbooks');
const stored = new Map();
globalThis.StorageManager = { get: key => stored.get(key) ?? null, set: (key, value) => stored.set(key, JSON.parse(JSON.stringify(value))) };
globalThis.FEATURES = { isEnabled: name => name === 'teach' };
const TaughtTasks = require('../js/core/taught-tasks');

const log = { startedAt: 1, endedAt: 2, events: [
    { type: 'page', url: 'https://app.schoology.com/home', title: 'Home | Schoology' },
    { type: 'click', role: 'a', label: 'Courses', href: 'https://app.schoology.com/courses' },
    { type: 'click', role: 'a', label: 'Courses', href: 'https://app.schoology.com/courses' },   // a double click
    { type: 'page', url: 'https://app.schoology.com/courses' },
    { type: 'type', role: 'input', label: 'Password', secure: true },
    { type: 'type', role: 'input', label: 'Search', value: 'Algebra', near: 'My courses' },
    { type: 'press', key: 'Enter', label: 'Search' },
    { type: 'choose', role: 'select', label: 'Period', value: 'This week' },
    { type: 'toggle', role: 'input', label: 'Show graded', checked: true },
    { type: 'download', name: 'assignments.pdf' },
    { type: 'page', url: 'https://www.google.com/search?q=x', title: 'x - Google Search' },
    { type: 'hover', label: 'ignored' }
] };

// T1: the transcript says exactly what was seen; a secure field has no value.
const text = TaughtTasks.transcript(log);
assert.match(text, /^On app\.schoology\.com — “Home \| Schoology”: https:\/\/app\.schoology\.com\/home\n  1\. Clicked “Courses” → app\.schoology\.com\/courses\n/);
assert.ok(!/2\. Clicked “Courses”/.test(text), 'a double click is one click');
assert.match(text, /Filled in “Password” \(only you can fill this; it was not recorded\)/);
assert.match(text, /Typed “Algebra” into “Search” \(under “My courses”\)/);
assert.match(text, /Pressed Enter in “Search”/);
assert.match(text, /Chose “This week” in “Period”/);
assert.match(text, /Ticked “Show graded”/);
assert.match(text, /A file was downloaded: assignments\.pdf/);
assert.ok(!/ignored|hover/.test(text), 'an unknown event type is left out');
assert.match(TaughtTasks.transcript({ ...log, full: true }), /reached its limit/);
assert.equal(TaughtTasks.transcript(null), '');

// T3: hosts are the recording's, most visited first, www stripped.
assert.deepEqual(TaughtTasks.hostsOf(log), ['app.schoology.com', 'google.com']);

// vet: a title, a note, hosts narrowed to the recording's, never widened.
assert.match(TaughtTasks.vet({ title: '', note: 'x' }, { log }).error, /needs a short title/);
assert.match(TaughtTasks.vet({ title: 'T', note: '' }, { log }).error, /needs the note/);
assert.match(TaughtTasks.vet({ title: 'T', note: 'x'.repeat(2401) }, { log }).error, /under 2400/);
assert.match(TaughtTasks.vet({ title: 'x'.repeat(61), note: 'n' }, { log }).error, /title under 60/);
let check = TaughtTasks.vet({ title: 'Schoology check', note: 'Open Courses, search the course, read the list.', hosts: ['https://app.schoology.com/x', 'evil.example'] }, { log });
assert.ok(check.ok); assert.deepEqual(check.item.hosts, ['app.schoology.com'], 'a host the recording never visited is dropped');
assert.equal(check.item.steps, 9, 'steps are the non-page events');
check = TaughtTasks.vet({ title: 'Schoology check', note: 'n' }, { log });
assert.deepEqual(check.item.hosts, ['app.schoology.com', 'google.com'], 'no hosts named: the recording\'s');
assert.match(TaughtTasks.vet({ title: 'T', note: 'n' }, { log: { events: [] } }).error, /No website was recorded/);

// save → stored, and registered as a playbook by title and by host (T4).
TaughtTasks.init();
const saved = TaughtTasks.save(TaughtTasks.vet({ title: 'Schoology check', note: 'Open Courses. Search the course name. Read what is due.', hosts: ['app.schoology.com'] }, { log }).item);
assert.equal(stored.get('taught-tasks').items.length, 1);
assert.equal(Playbooks.forTask('Run the taught task “Schoology check” and report what is due').length, 1, 'found by its title in a brief');
assert.equal(Playbooks.forTask('run the schoology   CHECK please')[0].id, `taught:${saved.id}`, 'title words, any spacing or case');
assert.equal(Playbooks.forUrl('https://app.schoology.com/courses').filter(b => b.taught).length, 1, 'found by host on the first look');
assert.equal(Playbooks.forUrl('https://schoology.com.evil.example/').filter(b => b.taught).length, 0);
const book = Playbooks.forUrl('https://app.schoology.com/')[0];
assert.match(book.note, /^Taught task “Schoology check”/); assert.match(book.note, /Read what is due\.$/);
assert.ok(book.note.length <= Playbooks.MAX_TAUGHT_NOTE);
assert.match(TaughtTasks.rosterLine(), /TAUGHT you by showing them once[\s\S]*- “Schoology check” on app\.schoology\.com/);

// A title with regex characters is still just a title.
const odd = TaughtTasks.save(TaughtTasks.vet({ title: 'Bills (Comcast) + PG&E?', note: 'n', hosts: ['x.test'] }, { log: { events: [{ type: 'page', url: 'https://x.test/' }] } }).item);
assert.equal(Playbooks.forTask('do the bills (comcast) + pg&e? run').length, 1);

// The person edits the note (T2): words change, facts stay; a bad edit is refused and nothing changes.
const edited = TaughtTasks.updateNote(saved.id, '  Open Courses first.  ');
assert.ok(edited.ok); assert.equal(TaughtTasks.get(saved.id).note, 'Open Courses first.');
assert.deepEqual(TaughtTasks.get(saved.id).hosts, ['app.schoology.com']);
assert.match(Playbooks.forUrl('https://app.schoology.com/')[0].note, /Open Courses first\.$/, 'the playbook follows the edit');
assert.match(TaughtTasks.updateNote(saved.id, '').error, /needs the note/);
assert.equal(TaughtTasks.get(saved.id).note, 'Open Courses first.');
assert.match(TaughtTasks.updateNote('nope', 'x').error, /No such/);

// A run is noted as a fact; a removal unregisters the playbook.
TaughtTasks.noteRun(saved.id, 'done');
assert.equal(TaughtTasks.get(saved.id).runs, 1); assert.equal(TaughtTasks.get(saved.id).lastRun.outcome, 'done');
assert.equal(TaughtTasks.remove(saved.id).title, 'Schoology check');
assert.equal(Playbooks.forUrl('https://app.schoology.com/').filter(b => b.taught).length, 0);
assert.equal(TaughtTasks.remove(saved.id), null);
assert.equal(TaughtTasks.all().length, 1); assert.equal(TaughtTasks.all()[0].id, odd.id);

// A fresh load registers what is stored.
const Again = (() => { delete require.cache[require.resolve('../js/core/taught-tasks')]; Playbooks.unregister(`taught:${odd.id}`); return require('../js/core/taught-tasks'); })();
// A restart with teaching disabled keeps stored notes intact and out of prompts.
globalThis.FEATURES = { isEnabled: () => false };
const beforeDisabled = JSON.stringify([...stored]);
const originalStore = globalThis.StorageManager;
let disabledReads = 0, disabledWrites = 0;
globalThis.StorageManager = { get() { disabledReads++; return originalStore.get('taught-tasks'); }, set() { disabledWrites++; } };
Again.init();
assert.deepEqual(Again.all(), []);
assert.equal(Again.get(odd.id), null);
assert.equal(Again.rosterLine(), '');
assert.equal(Again.remove(odd.id), null);
assert.ok(Again.updateNote(odd.id, 'changed').error);
assert.throws(() => Again.save(odd), /not enabled/);
Again.noteRun(odd.id, 'done');
assert.equal(Playbooks.forUrl('https://x.test/').filter(b => b.taught).length, 0);
assert.equal(JSON.stringify([...stored]), beforeDisabled);
assert.equal(disabledReads, 0, 'disabled tasks are never loaded');
assert.equal(disabledWrites, 0, 'disabled tasks are never changed');
// Explicit re-enabling restores the same notes.
globalThis.StorageManager = originalStore;
globalThis.FEATURES = { isEnabled: name => name === 'teach' };
Again.init();
assert.equal(Playbooks.forUrl('https://x.test/').filter(b => b.taught).length, 1, 'a kept task is a playbook again after a restart');

// The built-in lessons are untouched by any of this.
assert.ok(Playbooks.forTask('book two seats').some(b => b.id === 'tickets-and-seats'));
console.log('taught-tasks: ok');
