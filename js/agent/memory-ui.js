/**
 * MemoryUI — the one page where the person sees and edits what nenva
 * remembers (2026-10-01). It lives in Settings' Memory view
 * (#memories-settings-view) and is reached from Settings, the assistant's
 * memory button and the "Memory" link under an answer.
 *
 * One list, grouped by MemoryManager.HEADINGS. A fact is a row: click the
 * text to edit it in place (Enter saves, Escape cancels); hover shows a
 * star ("always remember" — carried into every chat) and a delete that
 * offers Undo. "Needs a look" appears only when a fact has gone six
 * months unconfirmed: Still true / Remove. Every word on the page is the
 * person's own or fixed copy; nothing here is model-written.
 */
const MemoryUI = {
    _query: '',
    _openPage: null,   // a page's facts are open (iOS: drilled in), or null for the index
    _editing: null,
    _wired: false,

    /** Open the Memory page; `page` scrolls to one page ("email"). */
    open({ page } = {}) {
        // In the simple shell, Memory is a row of the simple Settings.
        if (typeof SimpleSettings !== 'undefined' && typeof SimpleExperience !== 'undefined' && SimpleExperience.enabled) {
            if (typeof AgentUI !== 'undefined' && AgentUI.isOpen && AgentUI.mode !== 'app') AgentUI.close?.();
            this._openPage = page || null;
            SimpleSettings.open('memory');
            return;
        }
        if (typeof SettingsApp === 'undefined') return;
        if (typeof AgentUI !== 'undefined' && AgentUI.isOpen && AgentUI.mode !== 'app') AgentUI.close?.();
        AppManager.openApp('settings');
        setTimeout(() => {
            SettingsApp.openMemoriesSettings();
            if (page) setTimeout(() => document.querySelector(`#memory-list [data-page="${CSS.escape(page)}"]`)?.scrollIntoView({ block: 'start' }), 50);
        }, 0);
    },

    _esc(s) { return UIUtils.escapeHtml(s == null ? '' : String(s)); },

    render() {
        const host = document.getElementById('memory-page');
        if (!host || typeof MemoryManager === 'undefined') return;
        this._wire(host);
        const sel = host.querySelector('#memory-add-heading');
        if (sel) {
            const keep = sel.value;
            const opts = MemoryManager.listPages().map(h => `<option value="${this._esc(h.id)}">${this._esc(h.label)}</option>`).join('');
            if (sel._opts !== opts) { sel.innerHTML = opts; sel._opts = opts; if (keep) sel.value = keep; }
            // A page drilled into is where Add puts things.
            if (this._openPage && this._openPage !== '__look' && sel._for !== this._openPage) { sel.value = this._openPage; sel._for = this._openPage; }
            if (!this._openPage) sel._for = null;
        }
        const list = host.querySelector('#memory-list');
        const all = MemoryManager.all();
        const q = this._query.trim();
        const shown = q ? MemoryManager.search(q, { limit: 200 }) : all;

        if (!all.length) {
            list.innerHTML = `<p class="memory-empty">Nothing yet. nenva notes lasting things you tell it in chat (who you are, the people in your life, how you like things done), and you can add your own above.</p>`;
            return;
        }
        if (!shown.length) {
            list.innerHTML = `<p class="memory-empty">Nothing remembered matches “${this._esc(q)}”.</p>`;
            return;
        }

        // iOS Settings shape (2026-10-01): the index is a list of PAGES as
        // rows (coloured tile, label, count, chevron); a page opens its facts
        // in an inset group. A search shows matches grouped by page.
        let html = '';
        const look = q ? [] : MemoryManager.needsLook();
        const lookIds = new Set(look.map(f => f.id));
        const factsOn = (id) => shown.filter(f => f.heading === id && !lookIds.has(f.id))
            .sort((a, b) => (b.starred - a.starred) || (b.updatedAt || '').localeCompare(a.updatedAt || ''));
        const page = !q && this._openPage;
        if (page) {
            const isLook = page === '__look';
            const label = isLook ? 'Needs a look' : MemoryManager.headingLabel(page);
            const st = isLook ? { icon: 'look' } : this.pageStyle(page);
            const facts = isLook ? look : factsOn(page);
            const note = isLook ? 'Not mentioned in six months. Still true?'
                : page === 'email' ? 'What nenva shows or skips from your email. Tell it in chat to change this.' : '';
            html += `<button type="button" class="memory-back" data-act="index">‹ Memory</button>
                <div class="memory-page-head"><span class="memory-tile">${this._icon(st.icon)}</span><h2>${this._esc(label)}</h2></div>
                ${note ? `<p class="memory-page-note">${this._esc(note)}</p>` : ''}
                <div class="memory-ios-group">${facts.length ? facts.map(f => this._rowHtml(f, { look: isLook })).join('') : '<p class="memory-empty">Nothing here yet.</p>'}</div>`;
        } else if (q) {
            for (const h of MemoryManager.listPages()) {
                const facts = factsOn(h.id);
                if (!facts.length) continue;
                html += `<div class="memory-ios-section">${this._esc(h.label)}</div>
                    <div class="memory-ios-group">${facts.map(f => this._rowHtml(f)).join('')}</div>`;
            }
        } else {
            const row = (id, label, count, st) => `<button type="button" class="memory-page-row" data-act="page" data-page="${this._esc(id)}">
                <span class="memory-tile">${this._icon(st.icon)}</span><span class="memory-page-label">${this._esc(label)}</span>
                <span class="memory-page-count">${count}</span>
                <svg class="memory-chev" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg></button>`;
            if (look.length) html += `<div class="memory-ios-group">${row('__look', 'Needs a look', look.length, { icon: 'look' })}</div>`;
            const pages = MemoryManager.listPages().filter(h => factsOn(h.id).length || h.id === 'email');
            html += `<div class="memory-ios-group">${pages.map(h => row(h.id, h.label, factsOn(h.id).length, this.pageStyle(h.id))).join('')}</div>`;
        }
        list.innerHTML = html;
        if (this._editing) {
            const input = list.querySelector(`.memory-row[data-id="${CSS.escape(this._editing)}"] .memory-edit`);
            if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
        }
    },

    // Each memory page has its own icon (2026-10-01). Monochrome by
    // request ("let's avoid colors in those icons"): a quiet tile, ink glyph.
    PAGE_ICONS: { about: 'person', people: 'people', work: 'work', preferences: 'sliders', plans: 'flag', email: 'mail' },

    pageStyle(id) {
        return { icon: this.PAGE_ICONS[id] || 'page' };
    },

    _icon(name) {
        const p = {
            person: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20c1.2-3.6 4-5.5 7-5.5s5.8 1.9 7 5.5"/>',
            people: '<circle cx="9" cy="8.5" r="3"/><path d="M3.5 19c1-3 3-4.6 5.5-4.6s4.5 1.6 5.5 4.6"/><circle cx="16.5" cy="9" r="2.5"/><path d="M15.5 14.6c2.3 0 4 1.3 5 3.9"/>',
            work: '<rect x="3.5" y="7.5" width="17" height="12" rx="2"/><path d="M9 7.5V5.5a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 5.5v2"/><path d="M3.5 12.5h17"/>',
            sliders: '<path d="M5 6h9M18 6h1M5 12h3M12 12h7M5 18h11M20 18h-1"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
            flag: '<path d="M5 21V4"/><path d="M5 4h11l-2 4 2 4H5"/>',
            mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m4 7 8 6 8-6"/>',
            look: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
            page: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>'
        };
        return `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p[name] || p.page}</svg>`;
    },

    /** A preference's other answers, as taps (PrefAsks): changing it never needs typing. */
    _prefChips(f) {
        const p = f && f.meta && f.meta.pref && typeof PrefAsks !== 'undefined' ? PrefAsks.def(f.meta.pref) : null;
        if (!p) return '';
        const others = p.choices.filter(c => c.value !== f.meta.value);
        if (!others.length) return '';
        return `<span class="memory-pref-chips">${others.map(c => `<button type="button" class="memory-pref-chip" data-act="pref" data-value="${this._esc(JSON.stringify(c.value))}">${this._esc(c.label)}</button>`).join('')}</span>`;
    },

    _rowHtml(f, { look = false } = {}) {
        const editing = this._editing === f.id;
        const asOf = MemoryManager.asOfLabel(f);
        const from = f.quote ? `You said: “${f.quote}”` : f.source === 'you' ? 'Added by you'
            : f.source === 'default' ? 'A default — change or remove it anytime' : '';
        // A quiet second line: the person's own words when nenva has them,
        // or that it is one of the starting defaults.
        const meta = f.quote ? `<span class="memory-meta">You said “${this._esc(f.quote.length > 90 ? f.quote.slice(0, 89) + '…' : f.quote)}”</span>`
            : f.source === 'default' ? '<span class="memory-meta memory-meta--chip">Default</span>' : '';
        const star = `<button type="button" class="memory-act memory-star${f.starred ? ' is-on' : ''}" data-act="star" title="${f.starred ? 'Stop always remembering' : 'Always remember (in every chat)'}" aria-label="Always remember" aria-pressed="${!!f.starred}"><svg width="15" height="15" viewBox="0 0 24 24" fill="${f.starred ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round" aria-hidden="true"><path d="M12 3.5l2.6 5.3 5.9.9-4.25 4.1 1 5.8L12 16.9l-5.25 2.7 1-5.8L3.5 9.7l5.9-.9z"/></svg></button>`;
        const del = `<button type="button" class="memory-act memory-del" data-act="forget" title="Forget" aria-label="Forget"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/></svg></button>`;
        return `<div class="memory-row${f.starred ? ' is-starred' : ''}" data-id="${this._esc(f.id)}">
            ${editing
                ? `<input type="text" class="memory-edit" value="${this._esc(f.text)}" maxlength="${MemoryManager.TEXT_MAX}" aria-label="Edit">`
                : `<button type="button" class="memory-text" data-act="edit" title="${this._esc(from || 'Click to edit')}"><span class="memory-fact">${this._esc(f.text)}${asOf ? ` <span class="memory-asof">${this._esc(asOf)}</span>` : ''}</span>${meta}</button>`}
            ${this._prefChips(f)}
            <span class="memory-acts">${look
                ? `<button type="button" class="quiet-link-btn" data-act="confirm">Still true</button><button type="button" class="quiet-link-btn" data-act="forget">Remove</button>`
                : `${star}${del}`}</span>
        </div>`;
    },

    _wire(host) {
        if (this._wired) return;
        this._wired = true;
        // Repaint when the page is on screen, wherever it is hosted (Settings'
        // Memory view, or the simple Settings).
        MemoryManager.onChange(() => { if (host.offsetParent !== null && !this._editing) this.render(); });

        const search = host.querySelector('#memory-search');
        search.addEventListener('input', () => { this._query = search.value; this.render(); });

        const add = host.querySelector('#memory-add-input');
        const addIt = () => {
            const text = add.value.trim();
            if (!text) return;
            const res = MemoryManager.remember({ text, heading: host.querySelector('#memory-add-heading').value, source: 'you', newPage: true });
            if (res.error) { UIUtils.showToast(res.error, 'error'); return; }
            add.value = '';
            this._query = '';
            search.value = '';
            this.render();
        };
        add.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addIt(); } });
        host.querySelector('#memory-add-btn').addEventListener('click', addIt);

        const list = host.querySelector('#memory-list');
        list.addEventListener('click', e => {
            const btn = e.target.closest('[data-act]');
            if (btn && btn.dataset.act === 'page') {
                this._openPage = btn.dataset.page;
                // Adding while a page is open adds to that page.
                const sel = host.querySelector('#memory-add-heading');
                if (sel && this._openPage !== '__look') sel.value = this._openPage;
                this.render();
                return;
            }
            if (btn && btn.dataset.act === 'index') { this._openPage = null; this.render(); return; }
            const row = e.target.closest('.memory-row');
            if (!btn || !row) return;
            const id = row.dataset.id;
            const act = btn.dataset.act;
            if (act === 'edit') { this._editing = id; this.render(); }
            if (act === 'star') { const f = MemoryManager.get(id); if (f) MemoryManager.edit(id, { starred: !f.starred }); }
            if (act === 'confirm') MemoryManager.edit(id, {});
            if (act === 'pref') {
                const f = MemoryManager.get(id);
                let v; try { v = JSON.parse(btn.dataset.value); } catch { v = btn.dataset.value; }
                if (f && f.meta && f.meta.pref && typeof PrefAsks !== 'undefined') PrefAsks.set(f.meta.pref, v);
            }
            if (act === 'forget') {
                const f = MemoryManager.forget(id);
                if (f) UIUtils.showToast('Forgotten', 'success', 5000, { actionLabel: 'Undo', onAction: () => MemoryManager.restore(f) });
            }
        });
        const finish = (input, save) => {
            const id = input.closest('.memory-row')?.dataset.id;
            this._editing = null;
            if (save && id) {
                const text = input.value.trim();
                if (text) MemoryManager.edit(id, { text });
                else {
                    const f = MemoryManager.forget(id);
                    if (f) UIUtils.showToast('Forgotten', 'success', 5000, { actionLabel: 'Undo', onAction: () => MemoryManager.restore(f) });
                }
            }
            this.render();
        };
        list.addEventListener('keydown', e => {
            if (!e.target.classList.contains('memory-edit')) return;
            if (e.key === 'Enter') { e.preventDefault(); finish(e.target, true); }
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(e.target, false); }
        });
        list.addEventListener('focusout', e => {
            if (e.target.classList.contains('memory-edit') && this._editing) finish(e.target, true);
        });
    }
};
