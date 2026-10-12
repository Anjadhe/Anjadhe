/**
 * Notes pane behavior (2026-08-09, two reports in one session):
 *
 * 1. "clicking anywhere in a note adds a new line" — the rich editor's
 *    empty-space click handler inserted a <p> for a click in ANY vertical
 *    gap, including ordinary margins between paragraphs/lists where the
 *    browser would just place the caret. Pinned: a click only creates a
 *    line when the gap is walled by caret-proof blocks (code, divider) on
 *    both sides — the case the handler exists for.
 *
 * 2. Individually collapsible panes: the filters sidebar and note list
 *    fold on their own (per-Mac preference), and a deep-linked open
 *    (opts.focus — goals rows, assistant pills, record links) folds both
 *    TRANSIENTLY without touching the preference.
 */
module.exports = [
  {
    id: 'notes-click-never-inserts-line',
    name: 'a click in an ordinary gap places the caret; only caret-proof gaps insert',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async () => {
        AppManager.openApp('notes', false);
        NotesApp.openEditor(null, { template: 'blank' });
        const ed = RichEditor.editor;
        if (!ed) return { pass: false, detail: 'no editor mounted' };
        const fire = (clientY) => {
          let prevented = false;
          RichEditor._handleEmptyAreaClick({
            target: ed, detail: 1, clientY, preventDefault: () => { prevented = true; }
          });
          return prevented;
        };
        const midGap = (a, b) =>
          (a.getBoundingClientRect().bottom + b.getBoundingClientRect().top) / 2;
        try {
          // Ordinary content: two paragraphs and a list, with real margins.
          ed.innerHTML = '<p style="margin:0 0 24px">one</p>'
            + '<ul style="margin:0 0 24px"><li>bullet</li></ul>'
            + '<p style="margin:0">two</p>';
          const before = ed.childElementCount;
          const kids = ed.children;
          const p1 = fire(midGap(kids[0], kids[1]));   // gap above the list
          const p2 = fire(midGap(kids[1], kids[2]));   // gap below the list
          const p3 = fire(kids[2].getBoundingClientRect().bottom + 40); // below all
          const noInsert = ed.childElementCount === before
            && !p1 && !p2 && !p3;   // handler stood aside — browser places caret

          // The motivating case survives: a gap between two code blocks.
          ed.innerHTML = '<pre style="margin:0 0 24px">a()</pre><pre style="margin:0">b()</pre>';
          fire(midGap(ed.children[0], ed.children[1]));
          const insertedBetween = ed.childElementCount === 3
            && ed.children[1].tagName === 'P';

          // And below content whose last block can't hold a caret.
          ed.innerHTML = '<pre style="margin:0">a()</pre>';
          fire(ed.children[0].getBoundingClientRect().bottom + 40);
          const appendedAfterPre = ed.childElementCount === 2
            && ed.lastElementChild.tagName === 'P';

          return { pass: noInsert && insertedBetween && appendedAfterPre,
                   detail: JSON.stringify({ noInsert, insertedBetween, appendedAfterPre }) };
        } finally {
          ed.innerHTML = '';
          NotesApp._clearSelection();
        }
      });
    }
  },
  {
    id: 'notes-panes-collapse-and-focus-open',
    name: 'panes collapse individually (persisted); focus-opens fold transiently',
    kind: 'det',
    async run({ page }) {
      return await page.evaluate(async () => {
        AppManager.openApp('notes', false);
        const view = document.getElementById('notes-view');
        const K1 = 'notes-nav-collapsed', K2 = 'notes-list-collapsed';
        const prev = [localStorage.getItem(K1), localStorage.getItem(K2)];
        const id = 'note_panes_eval_1';
        const data = StorageManager.get('notes') || {};
        data.notes = data.notes || [];
        data.notes.push({ id, title: 'panes eval', content: '<p>x</p>',
          createdAt: new Date().toISOString(), modifiedAt: new Date().toISOString() });
        StorageManager.set('notes', { notes: data.notes });
        NotesApp.loadNotes();
        try {
          localStorage.setItem(K1, '0');
          localStorage.setItem(K2, '0');
          NotesApp._applyStoredPaneState();

          // Deep-linked open folds both — without touching the preference.
          NotesApp.openEditor(id, { focus: true });
          const folded = view.classList.contains('notes-nav-collapsed')
            && view.classList.contains('notes-list-collapsed');
          const prefUntouched = localStorage.getItem(K1) === '0'
            && localStorage.getItem(K2) === '0';

          // Leaving the note restores the stored preference (no dead end).
          NotesApp._clearSelection();
          const restored = !view.classList.contains('notes-nav-collapsed')
            && !view.classList.contains('notes-list-collapsed');

          // A manual toggle persists, and only its own pane moves.
          NotesApp.setPaneCollapsed('list', true);
          const individual = localStorage.getItem(K2) === '1'
            && view.classList.contains('notes-list-collapsed')
            && !view.classList.contains('notes-nav-collapsed');

          return { pass: folded && prefUntouched && restored && individual,
                   detail: JSON.stringify({ folded, prefUntouched, restored, individual }) };
        } finally {
          prev[0] === null ? localStorage.removeItem(K1) : localStorage.setItem(K1, prev[0]);
          prev[1] === null ? localStorage.removeItem(K2) : localStorage.setItem(K2, prev[1]);
          NotesApp._applyStoredPaneState();
          NotePrompts.remove(id);
        }
      });
    }
  }
];
