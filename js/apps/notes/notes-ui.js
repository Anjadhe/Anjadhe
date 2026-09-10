/**
 * Notes UI - Rendering with Tag System
 *
 * Three-pane layout (2026-07-20): this file renders the left filter nav
 * and the middle list column. The right pane (the always-editable note)
 * is driven by NotesApp directly.
 */

const NotesUI = {
    /**
     * Render notes list with sidebar
     * @param {Array} notes - Notes to render
     * @param {Array} tags - Available tags
     * @param {string} currentFilter - Current filter
     */
    render(notes, tags, currentFilter) {
        this.renderSidebar(NotesApp.notes, tags, currentFilter);
        this.renderNotes(notes, tags);
    },

    /**
     * Render sidebar: filters, tags
     */
    renderSidebar(allNotes, tags, currentFilter) {
        this.renderFilters(allNotes, currentFilter);
        this.renderTagFilters(allNotes, tags, currentFilter);
    },

    /**
     * Render main filter list (All, Pinned)
     */
    renderFilters(notes, currentFilter) {
        const container = document.getElementById('notes-filter-list');
        if (!container) return;

        const pinnedCount = notes.filter(n => n.pinned).length;
        // Routines and feed posts live on the Routines page / Home feed, not
        // in the notes lists — keep them out of the All count. Saved
        // (non-scheduled) prompt notes DO show here since 2026-07-31.
        const hiddenCount = notes.filter(n =>
            NoteTemplates.resolve(n) === 'feed' || NotePrompts.isRoutine(n)).length;
        const assistantCount = notes.filter(n => NoteTemplates.resolve(n) === 'assistant').length;

        container.innerHTML = `
            <div class="notes-filter-item ${currentFilter === 'all' ? 'active' : ''}" data-filter="all">
                <span class="notes-filter-name">All Notes</span>
                <span class="notes-filter-count">${notes.length - hiddenCount}</span>
            </div>
            ${assistantCount > 0 ? `
                <div class="notes-filter-item ${currentFilter === 'assistant' ? 'active' : ''}" data-filter="assistant">
                    <span class="notes-filter-name">AI Assistant</span>
                    <span class="notes-filter-count">${assistantCount}</span>
                </div>
            ` : ''}
            ${pinnedCount > 0 ? `
                <div class="notes-filter-item ${currentFilter === 'pinned' ? 'active' : ''}" data-filter="pinned">
                    <span class="notes-filter-name">Pinned</span>
                    <span class="notes-filter-count">${pinnedCount}</span>
                </div>
            ` : ''}
        `;

        if (!container.dataset.bound) {
            container.dataset.bound = 'true';
            container.addEventListener('click', (e) => {
                const item = e.target.closest('.notes-filter-item');
                if (!item) return;
                NotesApp.setFilter(item.dataset.filter);
            });
        }
    },

    /**
     * Render tag filter list
     */
    renderTagFilters(notes, tags, currentFilter) {
        const container = document.getElementById('notes-tag-filter-list');
        if (!container) return;

        // Routines and feed posts never show in the tag lists (see
        // NotesApp.getFilteredNotes), so keep them out of every count.
        const visible = notes.filter(n =>
            NoteTemplates.resolve(n) !== 'feed' && !NotePrompts.isRoutine(n));
        const tagCounts = {};
        visible.forEach(note => {
            if (note.tags) {
                note.tags.forEach(tagName => {
                    tagCounts[tagName] = (tagCounts[tagName] || 0) + 1;
                });
            }
        });

        const untaggedCount = visible.filter(n => !n.tags || n.tags.length === 0).length;

        // Show all tags — including those with zero notes, so newly created
        // tags are immediately discoverable. Sort: most-used first, then
        // alphabetical, so unused tags sink to the bottom without hiding.
        const sortedTags = [...tags].sort((a, b) => {
            const diff = (tagCounts[b.name] || 0) - (tagCounts[a.name] || 0);
            if (diff !== 0) return diff;
            return a.name.localeCompare(b.name);
        });

        // The sidebar tag search narrows this list only — it never touches
        // which notes show. The input lives in static HTML so its value
        // survives re-renders; the Untagged row bows out while searching.
        const searchEl = document.getElementById('notes-tag-search');
        const query = (searchEl?.value || '').trim().toLowerCase();
        const shownTags = query ? sortedTags.filter(t => t.name.toLowerCase().includes(query)) : sortedTags;
        if (searchEl && !searchEl.dataset.bound) {
            searchEl.dataset.bound = 'true';
            searchEl.addEventListener('input', () => {
                this.renderTagFilters(
                    NotesApp.notes,
                    NotesApp.activeProfileTags(),
                    NotesApp.currentFilter
                );
            });
            searchEl.addEventListener('keydown', (e) => {
                if (e.key === 'Escape') {
                    searchEl.value = '';
                    searchEl.dispatchEvent(new Event('input'));
                } else if (e.key === 'Enter') {
                    // Enter jumps straight to the top match.
                    const first = container.querySelector('.notes-tag-filter-row');
                    if (first) first.click();
                }
            });
        }

        if (query && shownTags.length === 0) {
            container.innerHTML = '<div class="notes-tag-search-empty">No matching tags</div>';
            return;
        }

        container.innerHTML = shownTags.map(tag => {
            const count = tagCounts[tag.name] || 0;
            const safeName = UIUtils.escapeHtml(tag.name);
            return `
            <div class="notes-filter-item notes-tag-filter-row ${currentFilter === tag.name ? 'active' : ''}" data-filter="${safeName}" data-tag-id="${tag.id}">
                <span class="notes-filter-name">${safeName}</span>
                <span class="notes-filter-count">${count}</span>
                <div class="notes-tag-actions">
                    <button class="notes-tag-action" data-tag-action="edit" data-tag-id="${tag.id}" title="Rename tag" aria-label="Rename tag">&#9998;</button>
                    <button class="notes-tag-action" data-tag-action="delete" data-tag-id="${tag.id}" title="Delete tag" aria-label="Delete tag">&times;</button>
                </div>
            </div>
        `;
        }).join('') + (!query && untaggedCount > 0 ? `
            <div class="notes-filter-item ${currentFilter === 'untagged' ? 'active' : ''}" data-filter="untagged">
                <span class="notes-filter-name">Untagged</span>
                <span class="notes-filter-count">${untaggedCount}</span>
            </div>
        ` : '');

        if (!container.dataset.bound) {
            container.dataset.bound = 'true';
            container.addEventListener('click', (e) => {
                const actionBtn = e.target.closest('[data-tag-action]');
                if (actionBtn) {
                    e.stopPropagation();
                    const tagId = actionBtn.dataset.tagId;
                    if (actionBtn.dataset.tagAction === 'edit') {
                        const tag = NotesApp.tags.find(t => t.id === tagId);
                        if (tag) NotesApp.showTagForm(tag);
                    } else if (actionBtn.dataset.tagAction === 'delete') {
                        NotesApp.deleteTag(tagId);
                    }
                    return;
                }
                const item = e.target.closest('.notes-filter-item');
                if (!item) return;
                NotesApp.setFilter(item.dataset.filter);
            });
        }
    },

    /**
     * Render the list column. Pinned notes get their own section rung
     * when the list mixes pinned and unpinned.
     */
    /**
     * "← All notes" above the list — rendered ONLY while a filter is
     * active AND the filters sidebar is not visible (explicitly collapsed
     * or hidden by a responsive breakpoint; offsetParent covers both).
     * With the sidebar up, its rows are the way back and the chip would be
     * duplication. Rendered before the empty-state early-return on
     * purpose: a tag with zero notes and no sidebar was a dead end.
     */
    renderFilterCrumb() {
        const slot = document.getElementById('notes-filter-crumb');
        if (!slot) return;
        const filter = NotesApp.currentFilter;
        const sidebar = document.querySelector('#notes-view .notes-sidebar');
        const sidebarHidden = !sidebar || sidebar.offsetParent === null;
        if (!filter || filter === 'all' || !sidebarHidden) {
            slot.innerHTML = '';
            return;
        }
        const label = { pinned: 'Pinned', assistant: 'AI Assistant', untagged: 'Untagged' }[filter] || filter;
        slot.innerHTML = `
            <button type="button" class="back-btn notes-filter-back">&larr; All notes</button>
            <span class="notes-filter-crumb-name">${UIUtils.escapeHtml(label)}</span>
        `;
        slot.querySelector('.notes-filter-back').addEventListener('click', () => NotesApp.setFilter('all'));
    },

    /**
     * First-run welcome in the note pane (the News-app recipe): shown only
     * while the app holds NO notes at all — "Select a note" means nothing
     * when there is nothing to select. Swapped back to the plain
     * placeholder the moment the first note exists.
     */
    renderPaneWelcome() {
        const host = document.getElementById('notes-note-empty');
        if (!host) return;
        // Count USER-facing notes only — the blob also holds routine notes
        // and feed posts (seeded on a fresh install), which the list itself
        // excludes; counting them kept the welcome from ever showing.
        const none = !(NotesApp.notes || []).some(n =>
            NoteTemplates.resolve(n) !== 'feed' && !NotePrompts.isRoutine(n));
        // The welcome IS the page while there are no notes: the view flag
        // lets the reader-off layout (the laptop default) show the pane
        // instead of an empty list (css/apps/notes.css).
        document.getElementById('notes-view')?.classList.toggle('notes-welcome', none);
        if (!none) {
            if (host.dataset.welcome) {
                delete host.dataset.welcome;
                host.innerHTML = `<p class="notes-note-empty-title">Select a note</p>
                    <p class="notes-note-empty-hint">&hellip;or start a new one.</p>`;
            }
            return;
        }
        if (host.dataset.welcome) return;
        host.dataset.welcome = '1';
        host.innerHTML = UIUtils.appWelcome({
            title: 'Your notebook',
            lede: 'Fast, plain notes — tagged and pinned. And because the assistant can read and write here, a note is never a dead end.',
            cta: '<button id="notes-welcome-new" class="primary-btn" type="button">+ New Note</button>',
            rows: [
                ['Write fast, file lightly',
                 'Tags and pins instead of folders. Find anything again from the tag list — or from anywhere with &#8984;K.'],
                ['The assistant works here too',
                 'Ask it to save an answer as a note, pull up the one you half-remember, or draft from what a note says.'],
                ['A note can be a book',
                 'The Book template turns a note into numbered chapters with PDF export — long writing lives here comfortably.']
            ]
        });
        host.querySelector('#notes-welcome-new')?.addEventListener('click', () =>
            document.getElementById('add-note-btn')?.click());
    },

    renderNotes(notes, tags) {
        const container = document.getElementById('notes-container');
        const emptyState = document.getElementById('notes-empty');
        this.renderFilterCrumb();
        this.renderPaneWelcome();
        if (!container) return;

        if (notes.length === 0) {
            container.style.display = 'none';
            if (emptyState) emptyState.style.display = 'block';
            return;
        }

        if (emptyState) emptyState.style.display = 'none';
        container.style.display = 'flex';
        container.className = 'notes-list';

        const pinned = notes.filter(n => n.pinned);
        const rest = notes.filter(n => !n.pinned);
        const section = (label, items) => `
            <div class="notes-section">
                <div class="notes-section-header">${label}<span class="notes-section-count">${items.length}</span></div>
                ${items.map(note => this.renderNoteListItem(note, tags)).join('')}
            </div>
        `;
        container.innerHTML = (pinned.length && rest.length)
            ? section('Pinned', pinned) + section('Notes', rest)
            : notes.map(note => this.renderNoteListItem(note, tags)).join('');

        this.attachEventListeners();
    },

    // Small template markers for non-blank notes in the list column.
    _templateMark(note, template) {
        if (template === 'prompt') return NoteTemplates.get('prompt').icon;
        if (template === 'assistant') return NoteTemplates.get('assistant').icon;
        if (template === 'feed') return NoteTemplates.get('feed').icon;
        if (template === 'book') return NoteTemplates.get('book').icon;
        return '';
    },

    /**
     * One list-column row: title + date line, then a dimmed preview line.
     * Selection (NotesApp.currentNoteId) renders as the surface-fill state.
     */
    renderNoteListItem(note, tags) {
        const preview = this.stripHtml(note.content);
        const template = (typeof NoteTemplates !== 'undefined') ? NoteTemplates.resolve(note) : 'blank';
        const mark = this._templateMark(note, template);
        const selected = NotesApp.currentNoteId === note.id;

        return `
            <div class="notes-list-item ${selected ? 'is-selected' : ''}" data-note-id="${note.id}" data-template="${template}">
                <div class="notes-list-line">
                    <span class="notes-list-title">${mark ? `<span class="notes-list-mark">${mark}</span> ` : ''}${UIUtils.escapeHtml(note.title)}</span>
                    <button class="note-action-btn pin-btn ${note.pinned ? 'is-pinned' : ''}" data-note-id="${note.id}" title="${note.pinned ? 'Unpin' : 'Pin'}" aria-label="${note.pinned ? 'Unpin note' : 'Pin note'}">&#128204;</button>
                    <span class="notes-list-date">${UIUtils.formatDate(note.modifiedAt)}</span>
                </div>
                ${preview ? `<div class="notes-list-preview">${preview}</div>` : ''}
            </div>
        `;
    },

    /**
     * Strip HTML to plain text for list preview
     * @param {string} html
     * @returns {string}
     */
    stripHtml(html) {
        const tmp = document.createElement('div');
        tmp.innerHTML = html;
        tmp.querySelectorAll('p, div, br, h1, h2, h3, li').forEach(el => {
            if (el.tagName === 'BR') {
                el.replaceWith(' ');
            } else {
                el.insertAdjacentText('afterend', ' ');
            }
        });
        return UIUtils.escapeHtml((tmp.textContent || tmp.innerText || '').trim().slice(0, 300));
    },

    /**
     * Attach event listeners to list rows
     */
    attachEventListeners() {
        document.querySelectorAll('#notes-container .notes-list-item').forEach(el => {
            el.addEventListener('click', (e) => {
                if (e.target.closest('.pin-btn')) return;
                NotesApp.openEditor(el.dataset.noteId);
            });
        });

        document.querySelectorAll('#notes-container .pin-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                NotesApp.togglePin(btn.dataset.noteId);
            });
        });
    },

    /**
     * Update only the selection highlight in the list column (cheap path
     * used when switching notes — avoids a full list rebuild).
     */
    updateSelection() {
        document.querySelectorAll('#notes-container .notes-list-item').forEach(el => {
            el.classList.toggle('is-selected', el.dataset.noteId === NotesApp.currentNoteId);
        });
    }
};
