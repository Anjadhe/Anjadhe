/**
 * Note Templates — registry of available templates plus content helpers.
 *
 * A template shapes how a note is created, edited, and read. v1 ships:
 *  - 'blank' — freeform rich text (the original notes experience)
 *  - 'book'  — chapters (one H1 per chapter) with a sticky TOC sidebar
 *
 * Chapter detection is intentionally derived from H1 headings inside
 * `note.content` rather than stored as a separate `chapters[]` array.
 * Three benefits:
 *  1. Zero schema churn — existing notes adopt the template by toggling
 *     a single field; no content migration.
 *  2. Standard editing already works — renaming, reordering, deleting
 *     chapters is just normal text editing.
 *  3. The same RichEditor singleton is reused; no per-chapter editor.
 *
 * Adding a template later: append to DEFINITIONS, add UI affordances in
 * the template menus, and (if it needs a specialized editor) wire up an
 * analog of `_setupBookEditor` in notes-app.
 */
const NoteTemplates = {
    DEFINITIONS: {
        blank: {
            id: 'blank',
            label: 'Blank',
            icon: '&#9998;', // pencil
            description: 'A freeform note. Type, format, and tag as you like.',
            seed: () => ({ content: '' })
        },
        book: {
            id: 'book',
            label: 'Book',
            icon: '&#128214;', // closed book
            description: 'Organize content as chapters with a table of contents.',
            // A book starts with one empty chapter so the TOC has something
            // to render and the user lands ready to type into chapter one.
            seed: () => ({
                content: '<h1>Chapter 1</h1><p><br></p>'
            })
        },
        assistant: {
            id: 'assistant',
            label: 'AI Assistant',
            icon: '&#10024;', // sparkles — the assistant's mark
            description: 'Created by the AI Assistant.',
            // Provenance type, not a user-pickable template: it marks notes
            // the assistant wrote (create_note tool). Hidden from the "new
            // note" template menus via `system`; edits like a blank note.
            system: true,
            seed: () => ({ content: '' })
        }
        // 'prompt' (a saved prompt / routine) and 'feed' (a routine run's
        // post) were retired 2026-10-07: a routine is a Standing chat and
        // its results are messages in it (NotePrompts). A stray record
        // still carrying either template resolves as 'blank'.
    },

    list() {
        return Object.values(this.DEFINITIONS);
    },

    get(id) {
        return this.DEFINITIONS[id] || this.DEFINITIONS.blank;
    },

    /**
     * Resolve a note's effective template id. Legacy notes (no template
     * field) read as 'blank' so they render exactly as before.
     */
    resolve(note) {
        const id = note && note.template;
        return this.DEFINITIONS[id] ? id : 'blank';
    },

    /**
     * Extract chapters (TOC entries) from a note's HTML content.
     * Returns an array of `{ index, title, slug }` in document order.
     * Slugs are de-duplicated so anchors stay unique when titles repeat.
     */
    extractChapters(html) {
        if (!html) return [];
        const tmp = document.createElement('div');
        tmp.innerHTML = html;
        return this._fromHeadings(tmp.querySelectorAll('h1'));
    },

    /**
     * Same as extractChapters but reads live H1 elements from a DOM root,
     * so the editor TOC stays in sync with what the user has typed.
     */
    extractChaptersFromElement(rootEl) {
        if (!rootEl) return [];
        return this._fromHeadings(rootEl.querySelectorAll('h1'));
    },

    _fromHeadings(headings) {
        const out = [];
        const seen = new Set();
        headings.forEach((h, i) => {
            const title = (h.textContent || '').trim() || `Chapter ${i + 1}`;
            const base = this._slugify(title);
            let slug = base, n = 2;
            while (seen.has(slug)) { slug = `${base}-${n++}`; }
            seen.add(slug);
            out.push({ index: i, title, slug });
        });
        return out;
    },

    _slugify(s) {
        return String(s).toLowerCase()
            .replace(/[^\w\s-]+/g, '')
            .trim()
            .replace(/\s+/g, '-')
            .slice(0, 64) || 'chapter';
    }
};
