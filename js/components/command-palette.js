/**
 * CommandPalette — ⌘K. The app list, and everything in it, one keystroke away.
 *
 * This is the piece that makes the nav collapse survivable (docs/POSITIONING.md,
 * 2026-07-29). With an empty query it lists your most-used apps and then every
 * other one, so ⌘K *is* the app launcher — the only one, since the All apps
 * sheet went 2026-07-30. Start typing and personal data joins in, ranked by
 * GlobalSearch.
 *
 * Built as a plain overlay rather than <dialog> on purpose: the UA gives
 * <dialog> a `color-scheme` of its own, and getting dark mode right there is
 * a known trap in this codebase for no benefit here.
 *
 * Keyboard is the whole point — ⌘K opens, typing filters, ↑/↓ move, Enter
 * opens, Esc closes. The mouse works too, but nothing is mouse-only.
 */
const CommandPalette = {
    _el: null,
    _input: null,
    _list: null,
    _hits: [],          // flat, in render order — the arrow keys walk this
    _active: 0,
    _open: false,
    _lastFocus: null,

    init() {
        document.addEventListener('keydown', (e) => {
            // Plain ⌘K only — ⌘⇧K is the rich editor's link shortcut.
            if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && (e.key === 'k' || e.key === 'K')) {
                // Setup owns the whole window; a launcher there would offer
                // apps the user has not finished configuring.
                if (document.body.classList.contains('in-setup')) return;
                e.preventDefault();
                this.toggle();
            }
        });
    },

    toggle() { this._open ? this.close() : this.show(); },

    show(prefill = '') {
        if (this._open) return;
        this._mount();
        this._open = true;
        this._lastFocus = document.activeElement;
        this._el.hidden = false;
        // One frame before the transition class so the fade actually runs.
        requestAnimationFrame(() => this._el.classList.add('is-open'));
        this._input.value = prefill;
        this._input.focus();
        this._render();
    },

    close() {
        if (!this._open || !this._el) return;
        this._open = false;
        this._el.classList.remove('is-open');
        this._el.hidden = true;
        this._input.value = '';
        // Give focus back to whatever the user was on, so Esc is a true undo.
        try { this._lastFocus?.focus?.(); } catch { /* element may be gone */ }
    },

    _mount() {
        if (this._el) return;
        const el = document.createElement('div');
        el.className = 'cmdk-overlay';
        el.hidden = true;
        el.innerHTML = `
            <div class="cmdk" role="dialog" aria-modal="true" aria-label="Search Anjadhe">
                <div class="cmdk-input-row">
                    <svg class="cmdk-input-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                         stroke-width="1.75" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><line x1="20" y1="20" x2="16.5" y2="16.5"/></svg>
                    <input class="cmdk-input" type="text" role="combobox" aria-expanded="true"
                           aria-controls="cmdk-list" aria-autocomplete="list"
                           placeholder="Search notes, tasks…" spellcheck="false" autocomplete="off">
                    <kbd class="cmdk-esc">esc</kbd>
                </div>
                <div class="cmdk-list" id="cmdk-list" role="listbox"></div>
            </div>`;
        document.body.appendChild(el);

        this._el = el;
        this._input = el.querySelector('.cmdk-input');
        this._list = el.querySelector('.cmdk-list');

        // Clicking the backdrop (but not the panel) dismisses.
        el.addEventListener('mousedown', (e) => { if (e.target === el) this.close(); });

        this._input.addEventListener('input', () => { this._active = 0; this._render(); });
        this._input.addEventListener('keydown', (e) => this._onKey(e));

        this._list.addEventListener('click', (e) => {
            const row = e.target.closest('.cmdk-row[data-idx]');
            if (row) this._choose(Number(row.dataset.idx));
        });
        // Pointer and keyboard share one selection model, so hovering moves
        // the highlight rather than fighting it.
        this._list.addEventListener('mousemove', (e) => {
            const row = e.target.closest('.cmdk-row[data-idx]');
            if (!row) return;
            const idx = Number(row.dataset.idx);
            if (idx === this._active) return;
            this._active = idx;
            this._paintActive();
        });
    },

    _onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); this.close(); return; }
        if (e.key === 'Enter') { e.preventDefault(); this._choose(this._active); return; }
        if (e.key === 'ArrowDown' || (e.key === 'n' && e.ctrlKey)) {
            e.preventDefault(); this._move(1); return;
        }
        if (e.key === 'ArrowUp' || (e.key === 'p' && e.ctrlKey)) {
            e.preventDefault(); this._move(-1); return;
        }
    },

    _move(delta) {
        if (!this._hits.length) return;
        // Wrap, so holding ↓ never dead-ends at the bottom.
        this._active = (this._active + delta + this._hits.length) % this._hits.length;
        this._paintActive();
    },

    _paintActive() {
        for (const row of this._list.querySelectorAll('.cmdk-row')) {
            const on = Number(row.dataset.idx) === this._active;
            row.classList.toggle('is-active', on);
            row.setAttribute('aria-selected', on ? 'true' : 'false');
            if (on) row.scrollIntoView({ block: 'nearest' });
        }
    },

    _choose(idx) {
        const hit = this._hits[idx];
        if (!hit) return;
        this.close();
        GlobalSearch.open(hit);
    },

    _render() {
        const q = this._input.value;
        const { frequent, apps, items, settings = [] } = GlobalSearch.search(q);
        const esc = UIUtils.escapeHtml.bind(UIUtils);

        this._hits = [
            ...frequent.map(a => ({ ...a, kind: 'app' })),
            ...apps.map(a => ({ ...a, kind: 'app' })),
            ...items.map(i => ({ ...i, kind: 'item' })),
            ...settings
        ];

        if (!this._hits.length) {
            this._list.innerHTML = `<div class="cmdk-empty">No matches for &ldquo;${esc(q)}&rdquo;</div>`;
            return;
        }

        let html = '';
        let idx = 0;
        const appRow = (a) => {
            const row = `<div class="cmdk-row" role="option" data-idx="${idx}" aria-selected="false">
                <span class="cmdk-row-icon">${a.icon}</span>
                <span class="cmdk-row-title">${esc(a.title)}</span>
                ${a.group ? `<span class="cmdk-row-badge">${esc(a.group)}</span>` : ''}
            </div>`;
            idx++;
            return row;
        };

        // Your most-used apps lead the empty query, so the default selection
        // is the app you open most — the common case is ⌘K and Enter. It was
        // most-RECENT until 2026-07-30; recency told you where you had just
        // been, which you already knew, and it reshuffled after every detour.
        if (frequent.length) {
            html += `<div class="cmdk-group-label">Most used</div>`;
            for (const a of frequent) html += appRow(a);
        }
        if (apps.length) {
            html += `<div class="cmdk-group-label">${
                q.trim() ? 'Apps' : (frequent.length ? 'Everything else' : 'All apps')
            }</div>`;
            for (const a of apps) html += appRow(a);
        }
        if (items.length) {
            html += `<div class="cmdk-group-label">Your data</div>`;
            for (const it of items) {
                const sub = it.sub || it.snippet || '';
                html += `<div class="cmdk-row" role="option" data-idx="${idx}" aria-selected="false">
                    <span class="cmdk-row-icon cmdk-row-icon--dot"></span>
                    <span class="cmdk-row-title">${esc(it.title)}</span>
                    ${sub ? `<span class="cmdk-row-sub">${esc(sub)}</span>` : ''}
                    <span class="cmdk-row-badge">${esc(GlobalSearch.appLabel(it.app))}</span>
                </div>`;
                idx++;
            }
        }
        if (settings.length) {
            html += `<div class="cmdk-group-label">Settings</div>`;
            for (const s of settings) {
                html += `<div class="cmdk-row" role="option" data-idx="${idx}" aria-selected="false">
                    <span class="cmdk-row-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></span>
                    <span class="cmdk-row-title">${esc(s.title)}</span>
                    <span class="cmdk-row-badge">${esc(s.sub)}</span>
                </div>`;
                idx++;
            }
        }
        this._list.innerHTML = html;
        if (this._active >= this._hits.length) this._active = 0;
        this._paintActive();
    }
};
