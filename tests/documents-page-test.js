#!/usr/bin/env node
// Documents (js/apps/documents/documents-page.js, 2026-10-07): one list over
// the notes blob and the library listing — the rows, the lede, the kinds and
// tags, search, the recency groups — and the laws that it reads only (D1) and
// writes no prose (D2).
const assert = require('assert');
const DP = require('../js/apps/documents/documents-page.js');
const now = new Date('2026-10-07T15:00:00');
const iso = (d, h = 9) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - d, h).toISOString();

const notes = [
    { id: 'n1', title: 'Letter to the landlord', modifiedAt: iso(0, 11), tags: ['Home'], template: 'assistant' },
    { id: 'n2', title: 'Packing list', modifiedAt: iso(3), tags: [] },
    // Routines and their results left the notes blob on 2026-10-07 (they are
    // Standing chats), so every note that is not a tombstone is a document.
    { id: 'n4', title: 'Gone', modifiedAt: iso(1), deletedAt: iso(0) },
    { id: 'n5', title: '', modifiedAt: iso(20) }
];
const docs = [
    { id: 'd1', relpath: 'taxes/2025-return.pdf', title: '2025 return', status: 'indexed', updatedAt: iso(2) },
    { id: 'd2', relpath: 'receipts/ikea.jpg', title: 'ikea', status: 'queued', updatedAt: iso(0, 8) }
];
const docTags = new Map([['d1', ['Finance/Taxes', 'Home']]]);
const kindOf = p => ({ key: /pdf$/.test(p) ? 'pdf' : 'image', label: /pdf$/.test(p) ? 'PDF' : 'Photo' });
const byNenva = n => n.template === 'assistant';
const rows = DP.rows({ notes, docs, docTags, kindOf, byNenva });

// ── Rows: both stores, newest first; prompt notes and tombstones never ──
{
    assert.deepEqual(rows.map(r => r.id), ['note:n1', 'doc:d2', 'doc:d1', 'note:n2', 'note:n5'], 'newest first across both stores');
    assert.ok(!rows.some(r => ['n3', 'n4', 'n6'].includes(r.ref)), 'a routine\'s prompt note, a run\'s post and a tombstone are not documents');
    assert.equal(rows.find(r => r.ref === 'n5').title, 'Untitled');
    assert.equal(rows.find(r => r.ref === 'n1').byNenva, true);
    assert.equal(rows.find(r => r.ref === 'd1').fileKind, 'PDF');
    assert.deepEqual(rows.find(r => r.ref === 'd1').tags, ['Finance/Taxes', 'Home']);
}

// ── Lede, kinds, tags ──
{
    assert.equal(DP.ledeText(rows), '3 written · 2 files');
    assert.equal(DP.ledeText([]), '');
    assert.deepEqual(DP.tagRow(rows), [{ tag: 'Home', n: 2 }, { tag: 'Finance', n: 1 }], 'a path tag counts by its root; most used first');
    assert.deepEqual(DP.tagRow([{ tags: ['work'] }, { tags: ['Work'] }, { tags: ['Work/Writing'] }]), [{ tag: 'Work', n: 3 }], 'one word per tag across the stores\' spellings');
    assert.deepEqual(rows.filter(r => DP.hasTag(r, 'home')).map(r => r.ref), ['n1', 'd1'], 'a tag spans both stores, case-insensitively');
}

// ── Search and groups ──
{
    assert.deepEqual(rows.filter(r => DP.matches(r, 'taxes pdf')).map(r => r.ref), ['d1'], 'every word, over title, tags and kind');
    assert.equal(rows.filter(r => DP.matches(r, '')).length, rows.length);
    const g = DP.groups(rows, now);
    assert.deepEqual(g.map(([label, list]) => [label, list.map(r => r.ref)]), [['Today', ['n1', 'd2']], ['This week', ['d1', 'n2']], ['Earlier', ['n5']]]);
    assert.equal(DP.when(Date.parse(iso(0, 11)), now), new Date(iso(0, 11)).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }), 'today says the time');
    assert.match(DP.when(Date.parse(iso(3)), now), /^Oct \d+$/, 'this week says the day, no year');
    assert.match(DP.subline(rows.find(r => r.ref === 'n1'), now), /^Written by nenva · Home · /);
    assert.match(DP.subline(rows.find(r => r.ref === 'd2'), now), /^Photo · being read · /, 'a file still indexing says so');
    assert.match(DP.subline(rows.find(r => r.ref === 'd1'), now), /Finance › Taxes, Home/);
}

// ── D1 / D2: reads only, writes no prose, opens through the existing doors ──
{
    const src = require('fs').readFileSync(require.resolve('../js/apps/documents/documents-page.js'), 'utf8');
    assert.ok(!/StorageManager\.set|electronLibrary\.(remove|delete|tag)|DocTags\.(set|forget|rename)/.test(src), 'the page changes nothing it holds (D1)');
    // D1 (2026-10-08): adding files goes through main's existing import, a copy into the folder.
    assert.ok(/electronLibrary\.importFiles\(\)/.test(src) && /electronLibrary\.importPaths\(paths\)/.test(src), 'Add files and a drop go through main\'s import');
    assert.ok(/DocTags\.add\(d\.id, tag, d\.relpath\)/.test(src), 'what lands while a tag is chosen wears it');
    assert.ok(!/LLMLogger|AgentService\.(chat|complete)|callModel/.test(src), 'nothing model-written (D2)');
    assert.ok(/this\.showDocument\(key === 'note' \? 'note' : 'file'/.test(src), 'a row opens the document on this page');
    assert.ok(/NotesApp\._loadNoteIntoPane\(/.test(src) && /DocReader\.create\(/.test(src), 'the surfaces that exist, hosted here: the notes editor element and a DocReader instance');
    assert.ok(!/ReaderApp\._reader/.test(src), 'never the library app\'s own reader');
}

// ── The import toast ──
{
    assert.equal(DP.importMessage({ canceled: true }), null, 'a cancelled picker says nothing');
    assert.deepEqual(DP.importMessage({ error: 'Disk full' }), { text: 'Disk full', type: 'error' });
    assert.deepEqual(DP.importMessage({ imported: 1, docs: [] }), { text: 'Added 1 file', type: 'success' });
    assert.deepEqual(DP.importMessage({ imported: 2, skipped: 1 }, 'Taxes', 2), { text: "Added 2 files to Taxes · 1 skipped (a kind of file nenva can't read)", type: 'success' });
    assert.deepEqual(DP.importMessage({ imported: 0, skipped: 1 }), { text: "1 skipped (a kind of file nenva can't read)", type: 'info' });
}

console.log('documents-page-test: ok');
