// Pins the pure helpers of js/core/content-files.js (docs/CONTENT_FILES.md):
// frontmatter round trip in the dialect Obsidian writes, filename rules, hash.
const assert = require('assert');
const CF = require('../js/core/content-files.js');

// frontmatter: stringify → parse is identity for the fields we write
const fm = { id: 'abc123', title: 'Plan: Q3 "launch"', created: '2026-08-26T10:00:00.000Z', modified: '2026-08-26T11:00:00.000Z', tags: ['work', 'q3 plan'], pinned: true, anjadhe: { template: 'blank', prompt: { time: '07:00' } } };
const text = CF.frontmatterStringify(fm) + '\n# Heading\n\nbody\n';
const parsed = CF.frontmatterParse(text);
assert.deepStrictEqual(parsed.data, fm);
assert.strictEqual(parsed.body, '# Heading\n\nbody\n');

// Obsidian-style block list + bare values + CRLF
const ob = '---\r\nid: x1\r\ntags:\r\n  - alpha\r\n  - beta\r\npinned: false\r\ndate: 2026-08-01\r\n---\r\nhello\r\n';
const p2 = CF.frontmatterParse(ob);
assert.deepStrictEqual(p2.data, { id: 'x1', tags: ['alpha', 'beta'], pinned: false, date: '2026-08-01' });
assert.strictEqual(p2.body, 'hello\r\n');

// no frontmatter → whole text is body, no data
assert.deepStrictEqual(CF.frontmatterParse('just text'), { data: {}, body: 'just text' });

// filenames: title slug, collision → id tail, keep a current name that still fits
const taken = new Set(['Groceries.md']);
assert.strictEqual(CF.fileNameFor('notes', { id: 'n_abcdef', title: 'Groceries' }, taken, null), 'Groceries abcdef.md');
assert.strictEqual(CF.fileNameFor('notes', { id: 'n_abcdef', title: 'Groceries' }, taken, 'Groceries.md'), 'Groceries.md');
assert.strictEqual(CF.fileNameFor('notes', { id: 'n1', title: 'a/b: c?' }, new Set(), null), 'a b c.md');
// title changed: our own derived name follows the title; a user-given name stays
assert.strictEqual(CF.fileNameFor('notes', { id: 'n1', title: 'New title' }, new Set(), 'Old title.md', 'Old title'), 'New title.md');
assert.strictEqual(CF.fileNameFor('notes', { id: 'n1', title: 'New title' }, new Set(), 'My own name.md', 'Old title'), 'My own name.md');
assert.strictEqual(CF.fileNameFor('notes', { id: 'n1', title: 'New title' }, new Set(), 'Whatever.md', undefined), 'Whatever.md');
assert.strictEqual(CF.fileNameFor('notes', { id: 'n1', title: '' }, new Set(), null), 'Untitled.md');
const d = new Date(2026, 7, 26, 9, 0, 0);
assert.strictEqual(CF.fileNameFor('journal', { id: 'j_123456', date: d.toISOString() }, new Set(), null), '2026-08-26.md');
assert.strictEqual(CF.fileNameFor('journal', { id: 'j_123456', date: d.toISOString() }, new Set(['2026-08-26.md']), null), '2026-08-26 123456.md');

// hash: stable, length-tagged, distinct
assert.strictEqual(CF.hash('abc'), CF.hash('abc'));
assert.notStrictEqual(CF.hash('abc'), CF.hash('abd'));
assert.ok(/:3$/.test(CF.hash('abc')));

// extensions
assert.strictEqual(CF.extFor('image/jpeg'), 'jpg');
assert.strictEqual(CF.extFor('video/quicktime'), 'mov');
assert.strictEqual(CF.extFor('image/x-unknown'), 'png');

console.log('content-files: all assertions passed');
