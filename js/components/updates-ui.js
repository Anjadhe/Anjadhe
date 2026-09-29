/**
 * UpdatesUI — the "Updates" section on a project sheet and a task sheet:
 * a composer on top, then the log newest-first. ONE renderer for both
 * hosts (the DecisionsUI contract), so an update reads the same wherever
 * it was posted.
 *
 * Who posts: the user from the composer (source 'user'), the assistant
 * from chat through post_update, and the weekly Project Review by mirror
 * (source 'ai', kind 'review' / 'risk'). The row says which — a sparkle
 * mark for Anjadhe, "You" for the user — and a kind tag when the update
 * is a review or a flagged risk. Nothing here is model-written at render
 * time; the section shows what was posted.
 *
 * Contract (the DecisionsUI shape):
 *   renderSection(key, opts) → HTML
 *     opts.title       heading (default "Updates")
 *     opts.checkIn     prompt string — renders "Ask Anjadhe to check in"
 *     opts.since       ISO — the record's creation, for the quiet note
 *     opts.compact     no composer foot copy (task sheet)
 *   attachListeners(container, key, onChanged)
 *   mount(el, key, opts) — render + attach + self-re-render on mutations
 */
const UpdatesUI = {
    SHOW_FIRST: 5,

    // Keys whose older updates are unfolded, per window.
    _showAll: new Set(),

    _esc(s) { return UIUtils.escapeHtml(s == null ? '' : String(s)); },

    _rowHtml(u) {
        const ai = u.source === 'ai';
        const kind = u.kind && u.kind !== 'update' ? u.kind : '';
        return `<div class="updates-row${ai ? ' is-ai' : ''}${kind ? ` is-${kind}` : ''}" data-update-id="${this._esc(u.id)}">
            <span class="updates-when" title="${this._esc(new Date(u.createdAt).toLocaleString())}">${this._esc(UpdateStore.ago(u.createdAt))}</span>
            <div class="updates-content">
                <span class="updates-who">${ai ? '<span class="updates-mark" aria-hidden="true"></span>Anjadhe' : 'You'}${kind ? `<span class="updates-kind">${this._esc(kind)}</span>` : ''}</span>
                <span class="updates-text">${this._esc(u.body)}</span>
            </div>
            <button type="button" class="updates-del" title="Remove this update">&times;</button>
        </div>`;
    },

    /** The header's right-hand note: last update age, or that it has gone quiet. */
    _statusHtml(list, opts) {
        const latest = list[0];
        const since = latest ? latest.createdAt : opts.since;
        const days = since ? UpdateStore.daysSince(since) : null;
        if (!latest) {
            const quiet = days !== null && days >= UpdateStore.QUIET_DAYS;
            return `<span class="updates-status${quiet ? ' is-quiet' : ''}">${quiet ? `No updates in ${days} days` : 'No updates yet'}</span>`;
        }
        const quiet = days !== null && days >= UpdateStore.QUIET_DAYS;
        return `<span class="updates-status${quiet ? ' is-quiet' : ''}">${quiet ? `Quiet for ${days} days` : `Last update ${this._esc(UpdateStore.ago(latest.createdAt))}`}</span>`;
    },

    renderSection(key, opts = {}) {
        if (typeof UpdateStore === 'undefined' || !key) return '';
        const list = UpdateStore.listFor(key);
        const showAll = this._showAll.has(key);
        const shown = showAll ? list : list.slice(0, this.SHOW_FIRST);
        const hidden = list.length - shown.length;
        const rows = shown.map(u => this._rowHtml(u)).join('');
        const moreBtn = (hidden > 0 || (showAll && list.length > this.SHOW_FIRST))
            ? `<button type="button" class="updates-more-btn quiet-link-btn">${showAll ? 'Show fewer' : `${hidden} earlier update${hidden === 1 ? '' : 's'}`}</button>`
            : '';
        const canAsk = opts.checkIn && typeof AgentUI !== 'undefined' && AgentUI.askWithPrompt;
        return `<div class="updates-section${opts.compact ? ' is-compact' : ''}" data-updates-key="${this._esc(key)}">
            <div class="detail-section-header-row">
                <span class="detail-section-header">${this._esc(opts.title || 'Updates')}${list.length ? ` <span class="detail-section-count">${list.length}</span>` : ''}</span>
                ${this._statusHtml(list, opts)}
            </div>
            <div class="updates-composer">
                <textarea class="updates-input" rows="1" placeholder="Post an update…" aria-label="Post an update"></textarea>
                <div class="updates-composer-foot">
                    <button type="button" class="updates-post-btn" disabled>Post</button>
                    <span class="updates-composer-hint">&#8984;&#8629; to post</span>
                    ${canAsk ? `<button type="button" class="updates-checkin-btn quiet-link-btn">Ask Anjadhe to check in</button>` : ''}
                </div>
            </div>
            ${rows ? `<div class="updates-rows">${rows}</div>` : ''}
            ${moreBtn}
        </div>`;
    },

    attachListeners(container, key, onChanged, opts = {}) {
        const section = container.querySelector(`[data-updates-key="${CSS.escape(key)}"]`) || container;
        const changed = () => { if (typeof onChanged === 'function') onChanged(); };

        const input = section.querySelector('.updates-input');
        const postBtn = section.querySelector('.updates-post-btn');
        const post = () => {
            const body = input.value.trim();
            if (!body) return;
            const res = UpdateStore.add({ key, body, source: 'user' });
            if (res.error) { UIUtils.showToast(res.error, 'error'); return; }
            input.value = '';
            changed();
        };
        if (input && postBtn) {
            input.addEventListener('input', () => { postBtn.disabled = !input.value.trim(); });
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); post(); }
            });
            postBtn.addEventListener('click', post);
        }

        section.querySelectorAll('.updates-del').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const id = btn.closest('.updates-row')?.dataset.updateId;
                const u = id && UpdateStore.get(id);
                if (!u) return;
                const ok = await UIUtils.confirm(
                    'Remove update',
                    `Remove &ldquo;${this._esc(u.body.slice(0, 80))}${u.body.length > 80 ? '…' : ''}&rdquo;?`,
                    '&#128465;',
                    { confirmText: 'Remove' }
                );
                if (!ok) return;
                UpdateStore.remove(id);
                changed();
            });
        });

        const more = section.querySelector('.updates-more-btn');
        if (more) {
            more.addEventListener('click', () => {
                if (this._showAll.has(key)) this._showAll.delete(key);
                else this._showAll.add(key);
                changed();
            });
        }

        const checkIn = section.querySelector('.updates-checkin-btn');
        if (checkIn && opts.checkIn) {
            checkIn.addEventListener('click', () => AgentUI.askWithPrompt(opts.checkIn, { newChat: true }));
        }
    },

    /**
     * Render into `el` and keep it live: mutations re-render this section
     * alone. A draft typed into the composer survives the re-render.
     */
    mount(el, key, opts = {}) {
        if (!el || typeof UpdateStore === 'undefined' || !key) return;
        const draw = () => {
            const draft = el.querySelector('.updates-input')?.value || '';
            el.innerHTML = this.renderSection(key, opts);
            if (draft) {
                const input = el.querySelector('.updates-input');
                if (input) { input.value = draft; el.querySelector('.updates-post-btn').disabled = false; }
            }
            this.attachListeners(el, key, () => {
                draw();
                if (typeof opts.onChanged === 'function') opts.onChanged();
            }, opts);
        };
        draw();
    }
};
