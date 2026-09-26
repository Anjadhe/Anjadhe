/**
 * DecisionsUI - the "Decisions" section on a record's detail page.
 *
 * One renderer for every host (task editor, goal detail, strategy detail,
 * portfolio account, routine detail) so a decision reads the same
 * everywhere — the insightActionRows rule: the same list rendering two
 * ways on two pages is one list telling two stories.
 *
 * Quiet reading surface in the app's design language: hairline rows, a
 * date gutter (the strategy _changeLog idiom), no card chrome. The user
 * can add by hand (saved with source:'user' — the model sees it exactly
 * like its own) and delete; editing is deliberately absent, matching the
 * store's append-and-supersede law (change a decision by saving a new one
 * under the same title, in chat or here).
 *
 * Contract (the TaskListUI shape):
 *   renderSection(key, opts) → HTML  (opts.title overrides "Decisions")
 *   attachListeners(container, key, onChanged)
 *   mount(el, key, opts) — render + attach + self-re-render on mutations
 */
const DecisionsUI = {

    // Keys whose superseded history is unfolded, per window — a re-render
    // mid-look must not snap the fold shut (the TaskListUI._showCompleted
    // recipe).
    _showHistory: new Set(),

    _esc(s) { return UIUtils.escapeHtml(s == null ? '' : String(s)); },

    _when(iso) {
        const d = new Date(iso);
        if (isNaN(d)) return '';
        const sameYear = d.getFullYear() === new Date().getFullYear();
        return d.toLocaleDateString('en-US', sameYear
            ? { month: 'short', day: 'numeric' }
            : { month: 'short', day: 'numeric', year: 'numeric' });
    },

    _rowHtml(d) {
        // The title is a supersede handle; when it's just the body's first
        // words (the derived default), printing it twice says nothing.
        const derived = (d.title || '') === (d.body || '').slice(0, d.title ? d.title.length : 0)
            && (d.body || '').startsWith(d.title || '');
        return `<div class="decisions-row${d.supersededAt ? ' is-superseded' : ''}" data-decision-id="${this._esc(d.id)}">
            <span class="decisions-when" title="${this._esc(new Date(d.createdAt).toLocaleString())}">${this._when(d.createdAt)}</span>
            <div class="decisions-content">
                ${!derived && d.title ? `<span class="decisions-title">${this._esc(d.title)}</span>` : ''}
                <span class="decisions-text">${this._esc(d.body)}</span>
                ${d.source === 'user' ? '' : `<span class="decisions-src">from chat</span>`}
            </div>
            <button type="button" class="decisions-del" title="Remove this decision">&times;</button>
        </div>`;
    },

    renderSection(key, opts = {}) {
        if (typeof DecisionStore === 'undefined' || !key) return '';
        const active = DecisionStore.listFor(key);
        const all = DecisionStore.listFor(key, { includeSuperseded: true });
        const superseded = all.filter(d => d.supersededAt);
        const showHistory = this._showHistory.has(key);

        const rows = active.map(d => this._rowHtml(d)).join('');
        const historyRows = showHistory ? superseded.map(d => this._rowHtml(d)).join('') : '';
        const historyBtn = superseded.length
            ? `<button type="button" class="decisions-history-btn quiet-link-btn">${showHistory ? 'Hide earlier versions' : `${superseded.length} earlier version${superseded.length === 1 ? '' : 's'}`}</button>`
            : '';

        // opts.bare — omit the standard header; the host supplies its own
        // section chrome (the strategy page's .strategy-section-head).
        const header = opts.bare ? '' : `<div class="detail-section-header-row">
                <span class="detail-section-header">${this._esc(opts.title || 'Decisions')}${active.length ? ` <span class="detail-section-count">${active.length}</span>` : ''}</span>
            </div>`;
        return `<div class="decisions-section${opts.bare ? ' is-bare' : ''}" data-decisions-key="${this._esc(key)}">
            ${header}
            ${rows ? `<div class="decisions-rows">${rows}</div>` : ''}
            ${historyRows ? `<div class="decisions-rows decisions-rows-history">${historyRows}</div>` : ''}
            ${historyBtn}
            <input type="text" class="decisions-add-input" placeholder="+ Add a decision about this…" aria-label="Add a decision">
        </div>`;
    },

    attachListeners(container, key, onChanged) {
        const section = container.querySelector(`[data-decisions-key="${CSS.escape(key)}"]`) || container;
        const changed = () => { if (typeof onChanged === 'function') onChanged(); };

        section.querySelectorAll('.decisions-del').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const row = btn.closest('.decisions-row');
                const id = row?.dataset.decisionId;
                const d = id && DecisionStore.get(id);
                if (!d) return;
                const ok = await UIUtils.confirm(
                    'Remove decision',
                    `Remove &ldquo;${this._esc(d.title || d.body.slice(0, 60))}&rdquo;? The assistant will stop seeing it when it reads this record.`,
                    '&#128465;',
                    { confirmText: 'Remove' }
                );
                if (!ok) return;
                DecisionStore.remove(id);
                changed();
            });
        });

        const historyBtn = section.querySelector('.decisions-history-btn');
        if (historyBtn) {
            historyBtn.addEventListener('click', () => {
                if (this._showHistory.has(key)) this._showHistory.delete(key);
                else this._showHistory.add(key);
                changed();
            });
        }

        const input = section.querySelector('.decisions-add-input');
        if (input) {
            input.addEventListener('keydown', (e) => {
                if (e.key !== 'Enter') return;
                const body = input.value.trim();
                if (!body) return;
                DecisionStore.saveSmart({ key, body, source: 'user' });
                input.value = '';
                changed();
            });
        }
    },

    /**
     * Render into `el` and keep it live: mutations re-render this section
     * alone, so hosts with expensive page renders can mount and forget.
     */
    mount(el, key, opts = {}) {
        if (!el || typeof DecisionStore === 'undefined' || !key) return;
        const draw = () => {
            el.innerHTML = this.renderSection(key, opts);
            this.attachListeners(el, key, () => {
                draw();
                if (typeof opts.onChanged === 'function') opts.onChanged();
            });
        };
        draw();
    }
};
