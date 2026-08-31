/**
 * Link Picker Component
 * Modal-based picker for selecting items from other apps to create cross-app links.
 * Also provides LinkedItemsUI for rendering linked items sections.
 */

const LinkPicker = {
    /**
     * App display labels
     */
    _builtinLabels: { goals: 'Goal', schedule: 'Task', notes: 'Note' },
    _builtinPlural: { goals: 'Goals', schedule: 'Tasks', notes: 'Notes' },
    // Registered app packages (LinkManager.registerApp) name themselves.
    get appLabels() {
        const out = { ...this._builtinLabels };
        for (const app in LinkManager._apps) out[app] = LinkManager._apps[app].label || app;
        return out;
    },
    get appLabelsPlural() {
        const out = { ...this._builtinPlural };
        for (const app in LinkManager._apps) out[app] = LinkManager._apps[app].plural || (LinkManager._apps[app].label || app) + 's';
        return out;
    },

    /**
     * Show the picker modal for selecting items from a target app
     * @param {Object} options
     * @param {string} options.targetApp - App to pick from ('goals'|'schedule'|'notes')
     * @param {string[]} options.exclude - IDs to exclude (already linked)
     * @param {Function} options.onSelect - Callback with selected item
     * @param {boolean} options.singleSelect - If true, auto-close after first selection (default: true)
     */
    show({ targetApp, exclude = [], onSelect, singleSelect = true }) {
        const label = this.appLabels[targetApp] || targetApp;
        const items = LinkManager.getAppItems(targetApp)
            .filter(item => !exclude.includes(item.id));

        let filteredItems = [...items];
        let modalInstance = null;

        const renderList = (container, query) => {
            const q = (query || '').toLowerCase();
            filteredItems = q
                ? items.filter(item => (item.title || '').toLowerCase().includes(q))
                : [...items];

            if (filteredItems.length === 0) {
                container.innerHTML = `<div class="link-picker-empty">No ${this.appLabelsPlural[targetApp] || 'items'} found</div>`;
                return;
            }

            // A real <button>, like the FYI rows this list is styled after:
            // it gets keyboard focus and Enter/Space activation for free,
            // which a clickable <div> never had.
            container.innerHTML = filteredItems.map(item =>
                `<button type="button" class="link-picker-item" data-id="${item.id}">
                    ${this.renderItemContent(targetApp, item)}
                </button>`
            ).join('');

            container.querySelectorAll('.link-picker-item').forEach(el => {
                el.addEventListener('click', () => {
                    const id = el.dataset.id;
                    const selected = items.find(i => i.id === id);
                    if (selected && onSelect) {
                        onSelect(selected);
                    }
                    if (singleSelect && modalInstance) {
                        modalInstance.close();
                    }
                });
            });
        };

        const content = document.createElement('div');
        content.className = 'link-picker';
        content.innerHTML = `
            <input class="search-input link-picker-search" type="text" placeholder="Search ${this.appLabelsPlural[targetApp] || 'items'}...">
            <div class="link-picker-list"></div>
        `;

        modalInstance = Modal.create({
            title: `Select ${label}`,
            content,
            className: 'link-picker-modal'
        });

        const searchInput = content.querySelector('.link-picker-search');
        const listContainer = content.querySelector('.link-picker-list');

        renderList(listContainer, '');

        searchInput.addEventListener('input', () => {
            renderList(listContainer, searchInput.value);
        });

        setTimeout(() => searchInput.focus(), 100);
    },

    /**
     * Render item content based on app type
     */
    renderItemContent(app, item) {
        switch (app) {
            case 'goals': {
                const statusLabel = GoalsApp.formatStatus(item.status || 'not-started');
                const target = item.targetDate
                    ? new Date(item.targetDate + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
                    : '';
                return `
                    <span class="link-picker-item-title">${UIUtils.escapeHtml(item.title)}</span>
                    <span class="link-picker-item-meta">${statusLabel}${target ? ' &middot; by ' + target : ''}</span>
                `;
            }
            case 'schedule': {
                const time = ScheduleUI.formatTimeRange(item.startTime, item.endTime);
                const repeat = ScheduleUI.getRepeatLabel(item);
                return `
                    <span class="link-picker-item-title">${UIUtils.escapeHtml(item.title)}</span>
                    <span class="link-picker-item-meta">${time}${repeat ? ' &middot; ' + repeat : ''}</span>
                `;
            }
            case 'notes': {
                const tags = (item.tags || []).join(', ');
                return `
                    <span class="link-picker-item-title">${UIUtils.escapeHtml(item.title)}</span>
                    ${tags ? `<span class="link-picker-item-meta">${UIUtils.escapeHtml(tags)}</span>` : ''}
                `;
            }
            default: {
                const meta = LinkManager._apps[app]?.renderMeta ? String(LinkManager._apps[app].renderMeta(item) || '') : '';
                return `
                    <span class="link-picker-item-title">${UIUtils.escapeHtml(item.title)}</span>
                    ${meta ? `<span class="link-picker-item-meta">${UIUtils.escapeHtml(meta)}</span>` : ''}
                `;
            }
        }
    }
};


/**
 * Linked Items UI
 * Renders linked items sections in app views with specific action buttons
 */
const LinkedItemsUI = {
    /**
     * Render a full linked items section for a given source item
     * @param {string} sourceApp - The app owning the source item
     * @param {string} sourceId - The source item's ID
     * @param {Object} config - Configuration for which sections to show
     * @param {Array} config.sections - Array of { targetApp, label, buttonLabel, singleSelect }
     * @param {Function} config.onChanged - Callback when links change (to re-render)
     * @returns {string} HTML string
     */
    renderAll(sourceApp, sourceId, config) {
        if (!sourceId) return '';

        const resolved = LinkManager.resolveLinks(sourceApp, sourceId);
        let html = '<div class="linked-items-container">';

        for (const section of config.sections) {
            const items = resolved[section.targetApp] || [];
            html += this.renderSection(sourceApp, sourceId, section, items);
        }

        html += '</div>';
        return html;
    },

    /**
     * Render a single linked items section
     */
    renderSection(sourceApp, sourceId, section, items) {
        const { targetApp, label, buttonLabel } = section;

        let createBtn = '';
        if (targetApp === 'notes') {
            createBtn = `<button class="secondary-btn linked-items-create-btn" data-source-app="${sourceApp}" data-source-id="${sourceId}" data-create-app="notes">+ New Note</button>`;
        } else if (targetApp === 'schedule') {
            createBtn = `<button class="secondary-btn linked-items-create-btn" data-source-app="${sourceApp}" data-source-id="${sourceId}" data-create-app="schedule">+ New Task</button>`;
        } else if (LinkManager._apps[targetApp]?.createLabel && LinkManager._apps[targetApp].createNew) {
            createBtn = `<button class="secondary-btn linked-items-create-btn" data-source-app="${sourceApp}" data-source-id="${sourceId}" data-create-app="${UIUtils.escapeHtml(targetApp)}">${UIUtils.escapeHtml(LinkManager._apps[targetApp].createLabel)}</button>`;
        }

        let html = `
            <div class="linked-items-section" data-target-app="${targetApp}">
                <div class="linked-items-header">
                    <span class="linked-items-label">${label}</span>
                    <div class="linked-items-actions">
                        ${createBtn}
                        <button class="secondary-btn linked-items-add-btn" data-source-app="${sourceApp}" data-source-id="${sourceId}" data-target-app="${targetApp}">${buttonLabel}</button>
                    </div>
                </div>
        `;

        if (items.length === 0) {
            html += `<div class="linked-items-empty">None</div>`;
        } else {
            html += '<div class="linked-items-list">';
            for (const item of items) {
                html += this.renderLinkedItem(sourceApp, sourceId, targetApp, item);
            }
            html += '</div>';
        }

        html += '</div>';
        return html;
    },

    /**
     * Render a single linked item chip
     */
    renderLinkedItem(sourceApp, sourceId, targetApp, item) {
        let metaHtml = '';
        let statusClassExtra = '';

        switch (targetApp) {
            case 'goals':
                // A goal is completed or it is not — no status dot; a
                // completed goal simply doesn't appear in pickers.
                break;
            case 'schedule': {
                const time = ScheduleUI.formatTime(item.startTime);
                // Mirror schedule grouping: a one-time item with any
                // lastCompletedDate is done; a repeating item is "done today"
                // only when lastCompletedDate is today. Overdue applies only
                // to one-time items dated before today and not yet completed.
                const isRepeating = item.repeat && item.repeat !== 'none';
                const today = ScheduleApp.getLocalToday();
                let status = 'pending';
                if (isRepeating) {
                    if (item.lastCompletedDate === today) status = 'completed';
                } else if (item.lastCompletedDate) {
                    status = 'completed';
                } else if (item.scheduledDate && item.scheduledDate < today) {
                    status = 'overdue';
                }
                statusClassExtra = ` linked-item-${status}`;
                const dateLabel = isRepeating
                    ? ScheduleUI.getRepeatLabel(item)
                    : (item.scheduledDate ? ScheduleUI.formatRelativeDate(item.scheduledDate, today) : '');
                const metaParts = [dateLabel, time].filter(Boolean).join(' &middot; ');
                metaHtml = `<span class="linked-item-status-dot ${status}" title="${status}"></span>` +
                    (metaParts ? `<span class="linked-item-meta">${metaParts}</span>` : '');
                break;
            }
            case 'notes':
                break;
            default: {
                const meta = LinkManager._apps[app]?.renderMeta ? String(LinkManager._apps[app].renderMeta(item) || '') : '';
                if (meta) metaHtml = `<span class="linked-item-meta">${UIUtils.escapeHtml(meta)}</span>`;
                break;
            }
        }

        return `
            <div class="linked-item${statusClassExtra}" data-app="${targetApp}" data-item-id="${item.itemId}" data-link-id="${item.linkId}" data-source-app="${sourceApp}" data-source-id="${sourceId}">
                ${metaHtml}
                <span class="linked-item-title">${UIUtils.escapeHtml(item.title)}</span>
                <button class="linked-item-remove" title="Remove link">&times;</button>
            </div>
        `;
    },

    /**
     * Format a YYYY-MM-DD string as "Apr 22" (same year) or "Apr 22, 2025"
     * (different year). Parses as a local date to avoid the UTC-midnight
     * off-by-one that afflicts `new Date('2026-04-22')` in negative zones.
     * Empty string for missing/invalid input.
     */
    _formatShortDate(ymd) {
        if (!ymd) return '';
        const parts = String(ymd).split('-').map(Number);
        if (parts.length !== 3 || parts.some(n => !Number.isFinite(n))) return '';
        const d = new Date(parts[0], parts[1] - 1, parts[2]);
        if (isNaN(d.getTime())) return '';
        const opts = d.getFullYear() === new Date().getFullYear()
            ? { month: 'short', day: 'numeric' }
            : { month: 'short', day: 'numeric', year: 'numeric' };
        return d.toLocaleDateString(undefined, opts);
    },

    /**
     * Attach event listeners to a rendered linked items container
     * @param {HTMLElement} container - The container element
     * @param {Function} onChanged - Callback to re-render after changes
     */
    attachListeners(container, onChanged) {
        if (!container) return;

        // Add buttons — open picker
        container.querySelectorAll('.linked-items-add-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const sourceApp = btn.dataset.sourceApp;
                const sourceId = btn.dataset.sourceId;
                const targetApp = btn.dataset.targetApp;

                // Get already-linked IDs to exclude
                const existingLinks = LinkManager.getLinksForApp(sourceApp, sourceId, targetApp);
                const excludeIds = existingLinks.map(l => l.itemId);

                LinkPicker.show({
                    targetApp,
                    exclude: excludeIds,
                    onSelect: (item) => {
                        LinkManager.addLink(sourceApp, sourceId, targetApp, item.id);
                        if (onChanged) onChanged();
                    }
                });
            });
        });

        // Create note/bookmark buttons — navigate to editor with auto-link context
        container.querySelectorAll('.linked-items-create-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const sourceApp = btn.dataset.sourceApp;
                const sourceId = btn.dataset.sourceId;
                const createApp = btn.dataset.createApp;
                const ctx = [{ app: sourceApp, itemId: sourceId }];

                const origin = { app: sourceApp, itemId: sourceId };

                if (createApp === 'notes') {
                    NotesApp.autoLinkContext = ctx;
                    AppManager.openApp('notes');
                    setTimeout(() => NotesApp.openEditor(null, { origin }), 0);
                } else if (createApp === 'schedule') {
                    ScheduleApp.autoLinkContext = ctx;
                    ScheduleApp.init();
                    setTimeout(() => ScheduleApp.openEditor(null, { origin }), 0);
                } else if (LinkManager._apps[createApp]?.createNew) {
                    LinkManager._apps[createApp].createNew(ctx, origin);
                }
            });
        });

        // Remove buttons
        container.querySelectorAll('.linked-item-remove').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const linkedItem = btn.closest('.linked-item');
                const sourceApp = linkedItem.dataset.sourceApp;
                const sourceId = linkedItem.dataset.sourceId;
                const targetApp = linkedItem.dataset.app;
                const targetId = linkedItem.dataset.itemId;

                LinkManager.removeLink(sourceApp, sourceId, targetApp, targetId);
                if (onChanged) onChanged();
            });
        });

        // Click on linked item — navigate to it, passing the source as
        // origin so the target's close/delete can return here.
        container.querySelectorAll('.linked-item').forEach(item => {
            item.addEventListener('click', (e) => {
                if (e.target.closest('.linked-item-remove')) return;
                const targetApp = item.dataset.app;
                const targetId = item.dataset.itemId;
                const sourceApp = item.dataset.sourceApp;
                const sourceId = item.dataset.sourceId;
                const opts = sourceApp && sourceId
                    ? { origin: { app: sourceApp, itemId: sourceId } }
                    : {};
                this.navigateToItem(targetApp, targetId, opts);
            });
        });
    },

    /**
     * Navigate to a linked item in its app
     */
    navigateToItem(app, itemId, opts = {}) {
        switch (app) {
            case 'goals':
                AppManager.openApp('goals');
                setTimeout(() => GoalsPage.selectNode('goal', itemId), 0);
                break;
            case 'schedule':
                // Straight to the full-page editor — openEditor switches views
                // itself; routing through the retired Tasks list page first
                // just flashed it for a frame.
                ScheduleApp.init();
                setTimeout(() => ScheduleApp.openEditor(itemId, opts), 0);
                break;
            case 'notes':
                AppManager.openApp('notes');
                // A linked-note row on another app's page is a deep link —
                // arrive on the note with the filters + list folded.
                setTimeout(() => NotesApp.openViewer(itemId, { ...opts, focus: true }), 0);
                break;
            default:
                if (LinkManager._apps[app]?.open) LinkManager._apps[app].open(itemId, opts);
                else AppManager.openApp(app);
        }
    }
};
