/**
 * Note formatting survives AI edits (2026-08-09: "everytime the ai
 * assistant updates a note it loses the formatting"). The loop was lossy at
 * the READ: get_note and the CURRENT NOTE block flattened the stored HTML
 * to plain text, so the model rewrote what it was shown — structure it
 * never saw — and update_note stored paragraphs. Pinned:
 *  - get_note returns markdown carrying the note's structure;
 *  - passing that markdown back through update_note re-stores the SAME
 *    structure (headings level-for-level — literalHeadings — lists,
 *    bold, quote, link);
 *  - the CURRENT NOTE context block carries the same markdown read;
 *  - notes with images are flagged so the model prefers append.
 */
const RICH = '<h1>Trip plan</h1><p>Some <strong>bold</strong> and <em>italic</em> and '
  + '<a href="https://example.com">a link</a></p><h2>Packing</h2>'
  + '<ul><li>passport</li><li>chargers</li></ul>'
  + '<blockquote><p>remember the adapter</p></blockquote>';

module.exports = [
  {
    id: 'notes-format-roundtrip',
    name: 'get_note returns markdown; update_note with it preserves the structure',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async (rich) => {
        const data = StorageManager.get('notes') || {};
        data.notes = data.notes || [];
        const id = 'note_fmt_eval_1';
        data.notes.push({ id, title: 'fmt eval', content: rich,
          createdAt: new Date().toISOString(), modifiedAt: new Date().toISOString() });
        StorageManager.set('notes', { notes: data.notes });
        try {
          const read = AgentTools.handlers.get_note({ id });
          const md = read.content || '';
          const readOk = read.format === 'markdown'
            && md.includes('# Trip plan')          // h1 → # (level kept)
            && md.includes('## Packing')
            && md.includes('**bold**') && md.includes('*italic*')
            && md.includes('[a link](https://example.com)')
            && md.includes('- passport')
            && md.includes('> remember the adapter');

          // The reported loop: the model passes the read back as content.
          AgentTools.handlers.update_note({ search: '', id, content: md });
          const stored = (StorageManager.get('notes').notes.find(n => n.id === id) || {}).content || '';
          const wroteOk = /<h1>Trip plan<\/h1>/.test(stored)     // literalHeadings, not h3
            && /<h2>Packing<\/h2>/.test(stored)
            && /<strong>bold<\/strong>/.test(stored)
            && /<em>italic<\/em>/.test(stored)
            && /<a href="https:\/\/example\.com">a link<\/a>/.test(stored)
            && /<ul><li>passport/.test(stored)
            && /<blockquote><p>remember the adapter<\/p><\/blockquote>/.test(stored);

          // And the round trip is STABLE: reading the rewritten note gives
          // the same markdown back (a second AI edit degrades nothing).
          const again = AgentTools.handlers.get_note({ id });
          const stable = again.content === md;

          return { pass: readOk && wroteOk && stable,
                   detail: JSON.stringify({ readOk, wroteOk, stable, md: md.slice(0, 200), stored: stored.slice(0, 300) }) };
        } finally {
          NotePrompts.remove(id);   // tombstoned — notes are record-merged
        }
      }, RICH);
    }
  },
  {
    id: 'notes-format-context-block-and-images',
    name: 'CURRENT NOTE block carries markdown; image notes are flagged',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async (rich) => {
        const data = StorageManager.get('notes') || {};
        data.notes = data.notes || [];
        const id1 = 'note_fmt_eval_2', id2 = 'note_fmt_eval_3';
        data.notes.push(
          { id: id1, title: 'fmt ctx', content: rich,
            createdAt: new Date().toISOString(), modifiedAt: new Date().toISOString() },
          { id: id2, title: 'fmt img', content: '<p>photo:</p><img src="data:image/png;base64,AAAA" alt="x">',
            createdAt: new Date().toISOString(), modifiedAt: new Date().toISOString() });
        StorageManager.set('notes', { notes: data.notes });
        try {
          NotesApp.loadNotes();
          const block = NotesApp.noteContextBlock(id1);
          const ctxOk = !!block && block.body.includes('# Trip plan')
            && block.body.includes('- passport') && block.body.includes('**bold**');

          const read = AgentTools.handlers.get_note({ id: id2 });
          const imgOk = read.hasImages === true && !!read.imagesNote
            && read.content.includes('(image)');

          return { pass: ctxOk && imgOk, detail: JSON.stringify({ ctxOk, imgOk }) };
        } finally {
          NotePrompts.remove(id1);
          NotePrompts.remove(id2);
        }
      }, RICH);
    }
  }
];
