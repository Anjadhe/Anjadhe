// NoteTags (js/core/note-tags.js): the tags the assistant may put on a note
// it writes. Pins NT1 (existing = the library plus every tag on a note, one
// spelling each), NT2 (existing tags win in their own spelling and silence
// invented ones; with no match exactly ONE new tag survives) and NT3 (what
// was dropped is named).
const assert = require('node:assert/strict');
const NoteTags = require('../js/core/note-tags.js');

// NT1
const stores = {
    tags: { tags: [{ name: 'work' }, { name: 'Personal' }, { name: '' }, null] },
    notes: { notes: [{ tags: ['Work', 'taxes'] }, { tags: ['#Taxes', 'Recipes'] }, { tags: null }, null] }
};
assert.deepEqual(NoteTags.existing(stores), ['work', 'Personal', 'taxes', 'Recipes'], 'library first, then note tags, one spelling each');
assert.deepEqual(NoteTags.existing({}), [], 'nothing stored is nothing');

// NT2 — existing tags win, in their own spelling, and silence invented ones
const existing = ['work', 'Personal', 'taxes'];
assert.deepEqual(NoteTags.resolve(['Work', 'Q3 planning', 'finance'], existing), { tags: ['work'], dropped: ['Q3 planning', 'finance'] });
assert.deepEqual(NoteTags.resolve(['#TAXES', 'personal', 'Taxes'], existing), { tags: ['taxes', 'Personal'], dropped: [] }, 'case and # folded, repeats collapsed');

// NT2 — no match: exactly one new tag
assert.deepEqual(NoteTags.resolve(['Garden', 'plants', 'spring'], existing), { tags: ['Garden'], dropped: ['plants', 'spring'] });
assert.deepEqual(NoteTags.resolve(['  '], existing), { tags: [], dropped: [] }, 'a blank proposal is no tag');
assert.deepEqual(NoteTags.resolve(undefined, existing), { tags: [], dropped: [] });
assert.deepEqual(NoteTags.resolve(['one'], undefined), { tags: ['one'], dropped: [] }, 'with no tags at all the one new tag is kept');

console.log('note-tags-test: ok');
