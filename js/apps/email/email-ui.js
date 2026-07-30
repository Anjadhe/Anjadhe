/**
 * Email UI
 * Renders email list, viewer, labels sidebar, priority settings, and insights
 */

const EmailUI = {
    render(emails, app) {
        const container = document.getElementById('email-container');
        const emptyState = document.getElementById('email-empty');
        const connectPrompt = document.getElementById('email-connect-prompt');

        if (!container) return;

        const profileAccounts = app.getAccounts();
        const toolbar = document.querySelector('#email-list-section .app-toolbar');
        if (profileAccounts.length === 0) {
            this.teardownListSentinel();
            this.renderBundleBar(null);
            container.innerHTML = '';
            container.style.display = 'none';
            if (emptyState) emptyState.style.display = 'none';
            if (toolbar) toolbar.style.display = 'none';
            if (connectPrompt) connectPrompt.style.display = '';
            return;
        }
        if (toolbar) toolbar.style.display = '';

        if (connectPrompt) connectPrompt.style.display = 'none';

        // Reflect the header view toggles (both live in static header HTML).
        this.setToggleState('email-filter-unread', app.showUnreadOnly,
            app.showUnreadOnly ? 'Showing unread only' : 'Show unread only');
        this.setToggleState('email-bundles-toggle', !app.bundlesOff,
            app.bundlesOff ? 'Group mail into bundles' : 'Bundles on — show one flat list');

        // Bundles collapse categorical mail (promos, finance, …) into one row
        // per topic — but only in the plain Inbox view. A search or another
        // label needs to show every matching row.
        const bundlesActive = app.bundlesActive();

        // Drilled into one bundle: the list is just that bundle's mail, flat,
        // with the breadcrumb (Email › Receipts) as the way back.
        const drilled = bundlesActive && app.currentBundle;
        if (drilled) emails = emails.filter(this.bundleFilter(app.currentBundle, app));

        // Whole-bundle verbs, for the view where the bundle's own hover chips
        // aren't on screen any more.
        this.renderBundleBar(drilled ? app.currentBundle : null, emails, app);

        if (emails.length === 0) {
            this.teardownListSentinel();
            container.innerHTML = '';
            container.style.display = 'none';
            if (emptyState) {
                // Under "Unread", an empty list is an achievement, not an absence.
                const h = emptyState.querySelector('h3');
                const p = emptyState.querySelector('p');
                // Inside a bundle, name it — "No emails" alone reads as a
                // broken inbox rather than an emptied-out bundle. The
                // breadcrumb is still the way out.
                if (h) h.textContent = drilled
                    ? app.bundleDisplayLabel(app.currentBundle)
                    : (app.showUnreadOnly ? 'No unread emails' : 'No emails');
                if (p) p.textContent = app.showUnreadOnly
                    ? 'You’re caught up. Switch to All to see everything.'
                    : (drilled
                        ? 'Nothing left in this bundle.'
                        : (app.currentAccount
                            ? `No emails in this label for ${app.currentAccount}`
                            : 'No emails in this label'));
                emptyState.style.display = '';
            }
            return;
        }

        container.style.display = '';
        if (emptyState) emptyState.style.display = 'none';

        // Show "Load older" until an account's backfill has hit the bottom of
        // its mailbox (date-anchored, so it survives syncs and re-opens).
        // Scoped to the selected account so the button doesn't dangle for
        // mailboxes the current view can't show.
        const hasMore = app.getScopedAccounts().some(a => !app.backfillDone[a.email]);
        // Disabled state derives from isSyncing at render time — the button is
        // rebuilt on every list render, so a mid-load render would otherwise
        // resurrect it looking clickable while the guard swallows the clicks.
        const loadMoreHtml = hasMore
            ? `<div class="email-load-more"><button id="email-load-more-btn" class="secondary-btn"${app.isSyncing ? ' disabled' : ''}>${app.isSyncing ? 'Loading...' : 'Load older emails'}</button></div>`
            : '';

        // Windowing: the list identity (label + scope + search + filter) decides
        // whether we're looking at a NEW list — which restarts the window at the
        // top — or re-rendering the same one after a mutation, which must keep
        // both the grown window and the scroll offset. render() fires on every
        // read-toggle and every sync, so rebuilding thousands of rows (and
        // snapping the user back to the top) each time was the bulk of the
        // sluggishness at large mailboxes.
        // 'email-detail' is the split view, where this same list stays docked
        // beside the viewer — opening a message must not count as a new list
        // (that would reset the window and jump the reader to the top).
        const viewKey = app.currentView === 'email-detail' ? 'emails' : app.currentView;
        const listKey = [
            viewKey, app.currentLabel, app.currentAccount || '',
            app.currentBundle || '', app.currentSearch || '',
            app.showUnreadOnly ? 'u' : 'a'
        ].join('|');
        const listChanged = listKey !== this._lastListKey;
        this._lastListKey = listKey;
        if (listChanged) this._renderLimit = this.ROWS_PER_PAGE;
        const prevScroll = listChanged ? 0 : container.scrollTop;

        // Flat, date-sorted list — no time buckets. Bundling already groups the
        // categorical noise, so a second axis of Today/This week headers just
        // fragmented each bundle across the page and read oddly. Every email
        // belongs to exactly one bundle: a real bundle, or the "Unbundled"
        // pseudo-bundle (personal + not-yet-classified mail). All of them
        // render as cards you open — a uniform set of piles reads better than
        // one group expanded inline while the rest stay shut.
        //
        // NOTE: _lastEmails stays the FULL filtered list, not the rendered
        // window — the bundle sweep actions (mark all read / archive all) act
        // on every email in a bundle, including ones not currently drawn.
        this._lastEmails = emails;
        let rowsHtml;
        let pending = 0;                  // rows withheld by the window
        if (bundlesActive && !drilled) {
            // One grouping pass. This used to re-filter the whole list once per
            // bundle, i.e. O(emails × bundles).
            const groups = new Map();
            for (const e of emails) {
                const b = app.isBundleActive(e.bundle) ? e.bundle : this.UNBUNDLED_KEY;
                const g = groups.get(b);
                if (g) g.push(e);
                else groups.set(b, [e]);
            }
            // `emails` is date-sorted, so Map insertion order already puts each
            // bundle where its newest mail falls. Unbundled leads regardless:
            // personal mail is the pile you came for, and a card that moves
            // around by date is a card you have to hunt for.
            const unbundled = groups.get(this.UNBUNDLED_KEY);
            groups.delete(this.UNBUNDLED_KEY);
            const ordered = unbundled
                ? [[this.UNBUNDLED_KEY, unbundled], ...groups.entries()]
                : [...groups.entries()];

            // Cards, not rows — there are a handful of bundles at most, so the
            // render window doesn't apply here.
            rowsHtml = ordered.map(([key, list]) => this.renderBundleCard(key, list, app)).join('');
        } else {
            const take = Math.min(emails.length, Math.max(0, this._renderLimit));
            pending = emails.length - take;
            rowsHtml = '';
            for (let i = 0; i < take; i++) rowsHtml += this.renderEmailRow(emails[i], app);
        }

        // While local rows are still withheld, the bottom of the list is a
        // sentinel that widens the window as it scrolls into view. "Load older
        // emails" (which fetches from Gmail) only appears once everything
        // already cached is on screen, so the two never compete for the bottom.
        const tailHtml = pending > 0
            ? '<div class="email-list-sentinel" aria-hidden="true"></div>'
            : loadMoreHtml;

        container.innerHTML = `<div class="email-group-rows">${rowsHtml}</div>` + tailHtml;
        container.scrollTop = prevScroll;
        this.bindListDelegates(app, container);
        this.observeListSentinel(app, container);
    },

    // How many email rows to draw at once, and how much each sentinel hit adds.
    ROWS_PER_PAGE: 80,
    _renderLimit: 80,
    _lastListKey: '',
    _rowObserver: null,

    _lastEmails: [],
    // Pseudo-bundle for personal + not-yet-classified mail ('none'/undefined/
    // hidden keys). Always rendered inline — human mail must stay visible.
    UNBUNDLED_KEY: '__unbundled',

    // Restart the render window at the top. Callers that change what the list
    // is showing without changing the list key (bundle drill-in/out) use this.
    resetListWindow() {
        this._renderLimit = this.ROWS_PER_PAGE;
    },

    // Membership test for one bundle key, shared by the drill-down filter and
    // the sweep actions.
    bundleFilter(bundleKey, app) {
        return bundleKey === this.UNBUNDLED_KEY
            ? (e) => !app.isBundleActive(e.bundle)
            : (e) => e.bundle === bundleKey;
    },

    // How many distinct sender names the second line of a card lists.
    BUNDLE_SENDERS: 4,

    // One line-art glyph per built-in bundle, in the same stroke style as the
    // viewer toolbar icons. Custom bundles (and anything unmapped) get the
    // folder. Deliberately not emoji — the palette is monochrome.
    BUNDLE_ICONS: {
        travel: '<path d="M17.8 19.2 16 11l3.5-3.5a2.1 2.1 0 0 0-3-3L13 8 4.8 6.2a.5.5 0 0 0-.5.8l3.2 3.9-2 2-2.3-.6a.5.5 0 0 0-.5.8L5 15.5 6.4 18l1.4-2.7 2 2-.6-2.3a.5.5 0 0 1 .8-.5l3.9 3.2a.5.5 0 0 0 .8-.5z"/>',
        purchases: '<path d="M16 10V6a4 4 0 0 0-8 0v4"/><path d="M3.8 8h16.4l1.2 12H2.6z"/>',
        finance: '<rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/>',
        social: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
        updates: '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>',
        forums: '<path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8z"/>',
        promos: '<path d="M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0L2 12V2h10l8.6 8.6a2 2 0 0 1 0 2.8z"/><line x1="7" y1="7" x2="7.01" y2="7"/>',
        __unbundled: '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
        _default: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
    },

    bundleIcon(bundleKey) {
        const paths = this.BUNDLE_ICONS[bundleKey] || this.BUNDLE_ICONS._default;
        return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
    },

    /**
     * One card per bundle. A card, not a row: the point of a pile is deciding
     * whether to open it, and a name plus a count doesn't tell you that. So
     * the first line is icon · name · unread · newest date, and the second
     * names who has been writing, most recent first. Clicking anywhere on the
     * card drills in — the list becomes just that bundle's mail, named in the
     * breadcrumb.
     */
    renderBundleCard(bundleKey, emails, app) {
        const isUnbundled = bundleKey === this.UNBUNDLED_KEY;
        const safeLabel = UIUtils.escapeHtml(isUnbundled ? 'Unbundled' : app.bundleLabel(bundleKey));

        let unread = 0;
        for (const e of emails) if (!e.isRead) unread++;

        // Distinct senders in recency order — `emails` is date-sorted, and a
        // pile of ten notes from one shop shouldn't read as ten names. No
        // "+N" tail: on a real mailbox that's a four-digit number nobody
        // asked for, and the point of the line is who wrote recently.
        const seen = new Set();
        for (const e of emails) {
            seen.add(this.extractName(e.from));
            if (seen.size >= this.BUNDLE_SENDERS) break;
        }
        const shown = [...seen].join(', ');

        return `
            <div class="email-bundle" data-bundle="${bundleKey}">
                <div class="email-bundle-card email-bundle-trigger ${unread > 0 ? 'has-unread' : ''}"
                     role="button" tabindex="0" title="Open ${safeLabel}"
                     aria-label="Open ${safeLabel}${unread > 0 ? `, ${unread} unread` : ''}">
                    <span class="email-bundle-icon" aria-hidden="true">${this.bundleIcon(bundleKey)}</span>
                    <div class="email-bundle-body">
                        <div class="email-bundle-head">
                            <span class="email-bundle-name">${safeLabel}</span>
                            ${unread > 0 ? `<span class="email-bundle-unread">${unread} new</span>` : ''}
                            <span class="email-bundle-date">${this.formatDate(emails[0].date)}</span>
                        </div>
                        <div class="email-bundle-senders">${UIUtils.escapeHtml(shown)}</div>
                    </div>
                    <!-- No hover actions here: the whole-pile verbs live in the
                         sweep bar inside the bundle, where the mail they act on
                         is on screen. Sweeping a pile shut from a card you
                         hadn't opened was a lot of consequence for a hover. -->
                </div>
            </div>
        `;
    },

    // Every message id in a bundle — the full set, not just the drawn window,
    // so "Mark all read" / "Archive all" still sweep the whole bundle.
    bundleMessageIds(bundleKey, app) {
        return (this._lastEmails || []).filter(this.bundleFilter(bundleKey, app)).map(e => e.messageId);
    },

    // A header icon toggle: filled when on, and its tooltip says what a click
    // will do rather than restating the state.
    setToggleState(id, on, title) {
        const btn = document.getElementById(id);
        if (!btn) return;
        btn.classList.toggle('is-active', !!on);
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
        if (title) {
            btn.title = title;
            btn.setAttribute('aria-label', title);
        }
    },

    /**
     * Sweep bar for a drilled-into bundle: the same verbs the bundle card
     * offers on hover, plus Mark all unread, applied to everything the list is
     * currently showing (so under the Unread filter they act on the unread
     * mail, which is what's on screen). `bundleKey` null hides the bar.
     */
    renderBundleBar(bundleKey, emails, app) {
        const bar = document.getElementById('email-bundle-bar');
        if (!bar) return;
        if (!bundleKey || !emails || emails.length === 0) {
            bar.style.display = 'none';
            bar.innerHTML = '';
            return;
        }

        let unread = 0;
        for (const e of emails) if (!e.isRead) unread++;
        const n = emails.length;
        const label = UIUtils.escapeHtml(app.bundleDisplayLabel(bundleKey));

        const count = `${n} message${n === 1 ? '' : 's'}${unread > 0 ? `, ${unread} unread` : ''}`;
        bar.innerHTML = `
            <span class="email-bundle-bar-count">${count}</span>
            ${unread > 0 ? `<button class="email-bundle-act" data-bar-act="read" type="button" title="Mark everything shown in ${label} as read">Mark all read</button>` : ''}
            ${unread < n ? `<button class="email-bundle-act" data-bar-act="unread" type="button" title="Mark everything shown in ${label} as unread">Mark all unread</button>` : ''}
            <button class="email-bundle-act" data-bar-act="archive" type="button" title="Archive everything shown in ${label}">Archive all</button>
        `;
        bar.style.display = '';
        this.bindBundleBar(app, bar);
    },

    // Delegated once; the handler reads the app off the element so a profile
    // switch never leaves a stale closure behind (same idiom as the list).
    bindBundleBar(app, bar) {
        bar._emailApp = app;
        if (bar._emailDelegated) return;
        bar._emailDelegated = true;

        bar.addEventListener('click', async (e) => {
            const btn = e.target.closest('[data-bar-act]');
            const a = bar._emailApp;
            if (!btn || !a) return;
            const key = a.currentBundle;
            if (!key) return;
            const ids = this.bundleMessageIds(key, a);
            if (!ids.length) return;
            const act = btn.dataset.barAct;
            if (act === 'read') a.markEmailsRead(ids);
            else if (act === 'unread') a.markEmailsUnread(ids);
            else if (act === 'archive') {
                // Archiving a pile is the one sweep that takes mail off the
                // screen, so it asks first.
                const ok = await UIUtils.confirm(
                    'Archive all',
                    `Archive ${ids.length} email${ids.length === 1 ? '' : 's'} in ${a.bundleDisplayLabel(key)}?`,
                    ''
                );
                if (ok) a.archiveEmails(ids);
            }
        });
    },

    /**
     * "Move to bundle" picker: choose a bundle (or Don't bundle) for one
     * email, with an "always for this sender" checkbox — checked by default,
     * because categorical mail is almost always a per-sender decision.
     */
    showBundlePicker(email, app) {
        const sender = app.senderAddress(email);
        const current = email.bundle || 'none';
        const options = [
            ...app.activeBundleDefs().map(d => ({ key: d.key, label: d.label })),
            { key: 'none', label: 'Don’t bundle' },
        ];
        const content = `
            <div class="bundle-picker">
                <div class="bundle-picker-options">
                    ${options.map(o => `
                        <label class="bundle-picker-option">
                            <input type="radio" name="bundle-pick" value="${UIUtils.escapeHtml(o.key)}" ${o.key === current ? 'checked' : ''}>
                            <span>${UIUtils.escapeHtml(o.label)}</span>
                        </label>`).join('')}
                </div>
                <label class="bundle-picker-sender">
                    <input type="checkbox" id="bundle-pick-sender" checked>
                    <span>Always, for all mail from <strong>${UIUtils.escapeHtml(sender)}</strong></span>
                </label>
            </div>`;
        let modal;
        modal = Modal.create({
            title: 'Move to bundle',
            content,
            className: 'bundle-picker-modal',
            buttons: [
                { text: 'Cancel', className: 'secondary-btn', onClick: () => modal.close() },
                {
                    text: 'Move',
                    className: 'primary-btn',
                    onClick: () => {
                        const key = modal.element.querySelector('input[name="bundle-pick"]:checked')?.value;
                        const toSender = !!modal.element.querySelector('#bundle-pick-sender')?.checked;
                        modal.close();
                        if (key) app.setEmailBundle(email.messageId, key, toSender);
                    }
                },
            ],
        });
    },

    renderEmailRow(email, app) {
        const fromName = this.extractName(email.from);
        const date = this.formatDate(email.date);
        const unreadClass = email.isRead ? '' : 'email-unread';
        const isPriority = app.isPrioritySender(email);
        const analysis = app.priorityAnalyses[email.messageId];

        let indicators = '';
        if (isPriority) {
            indicators += `<span class="email-priority-indicator" title="Priority sender">&#9679;</span>`;
        }
        if (analysis?.actionItems?.length > 0) {
            indicators += `<span class="email-action-indicator" title="${analysis.actionItems.length} action item(s)">&#9744;</span>`;
        }

        const selectedClass = (app.currentView === 'email-detail' && app.currentEmailId === email.messageId)
            ? 'is-selected' : '';
        return `
            <div class="email-row ${unreadClass} ${selectedClass} ${isPriority ? 'email-priority-row' : ''}" data-id="${email.messageId}">
                <div class="email-row-indicators">${indicators}</div>
                <div class="email-row-from">${UIUtils.escapeHtml(fromName)}</div>
                <div class="email-row-content">
                    <span class="email-row-subject">${UIUtils.escapeHtml(email.subject || '(no subject)')}</span>
                    <span class="email-row-snippet"> &mdash; ${UIUtils.escapeHtml(email.snippet || '')}</span>
                </div>
                <!-- Hover actions overlay the date (Gmail-style) — text labels,
                     not glyph buttons: self-describing beats tiny icons. -->
                <div class="email-row-actions">
                    <button class="email-bundle-move-btn" data-id="${email.messageId}" title="Move to bundle...">Bundle</button>
                    <button class="email-read-btn" data-id="${email.messageId}">${email.isRead ? 'Mark unread' : 'Mark read'}</button>
                </div>
                <div class="email-row-date">${date}</div>
            </div>
        `;
    },

    extractName(fromStr) {
        if (!fromStr) return 'Unknown';
        const match = fromStr.match(/^([^<]+)</);
        if (match) return match[1].trim().replace(/"/g, '');
        return fromStr.split('@')[0];
    },

    formatDate(dateStr) {
        if (!dateStr) return '';
        const date = new Date(dateStr);
        const now = new Date();
        const isToday = date.toDateString() === now.toDateString();

        if (isToday) {
            return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        }

        const yesterday = new Date(now);
        yesterday.setDate(yesterday.getDate() - 1);
        if (date.toDateString() === yesterday.toDateString()) {
            return 'Yesterday';
        }

        if (date.getFullYear() === now.getFullYear()) {
            return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
        }

        return date.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
    },

    /**
     * One delegated click handler for the whole list, bound once.
     *
     * This used to attach three listeners per row on every render — 15k
     * registrations per repaint at 5k emails, redone for every read-toggle and
     * every sync. Delegation makes it O(1) and, together with the render
     * window, keeps the cost of a repaint independent of mailbox size.
     */
    bindListDelegates(app, container) {
        // The handler reads the app off the container so a rebind (profile
        // switch) never leaves a stale closure behind.
        container._emailApp = app;
        if (container._emailDelegated) return;
        container._emailDelegated = true;

        container.addEventListener('click', (e) => {
            const a = container._emailApp;
            if (!a) return;

            const readBtn = e.target.closest('.email-read-btn');
            if (readBtn) {
                e.stopPropagation();
                a.toggleEmailRead(readBtn.dataset.id);
                return;
            }

            const moveBtn = e.target.closest('.email-bundle-move-btn');
            if (moveBtn) {
                e.stopPropagation();
                const email = a.emailById(moveBtn.dataset.id);
                if (email) this.showBundlePicker(email, a);
                return;
            }

            // Draft rows reuse .email-row but carry data-draft-id and bind
            // their own handler in renderDrafts — never route them here.
            const row = e.target.closest('.email-row');
            if (row && row.dataset.id && !row.classList.contains('email-draft-row')) {
                a.openViewer(row.dataset.id);
                return;
            }

            const bundleRow = e.target.closest('.email-bundle-trigger');
            if (bundleRow) {
                const key = bundleRow.closest('.email-bundle')?.dataset.bundle;
                if (key) a.openBundle(key);
                return;
            }

            if (e.target.closest('#email-load-more-btn')) a.loadMoreEmails();
        });

        // Bundle rows are role="button" — keyboard users get the same open.
        container.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            const bundleRow = e.target.closest('.email-bundle-trigger');
            if (!bundleRow) return;
            e.preventDefault();
            const key = bundleRow.closest('.email-bundle')?.dataset.bundle;
            if (key) container._emailApp?.openBundle(key);
        });
    },

    // The reading pane with nothing selected. Swaps the message body for a
    // quiet placeholder so the pane can stay docked at rest.
    setViewerEmpty(isEmpty) {
        const main = document.querySelector('#email-viewer-section .email-viewer-main');
        const empty = document.getElementById('email-viewer-empty');
        if (main) main.style.display = isEmpty ? 'none' : '';
        if (empty) empty.style.display = isEmpty ? '' : 'none';
    },

    /**
     * Widen the render window when the bottom sentinel comes into view. The
     * observer is re-created per render because innerHTML replaces the node it
     * watches; it disconnects itself on the first hit so one scroll past the
     * threshold adds exactly one page.
     */
    observeListSentinel(app, container) {
        this.teardownListSentinel();
        const sentinel = container.querySelector('.email-list-sentinel');
        if (!sentinel || typeof IntersectionObserver === 'undefined') return;

        const observer = new IntersectionObserver((entries) => {
            if (!entries.some(en => en.isIntersecting)) return;
            observer.disconnect();
            if (this._rowObserver === observer) this._rowObserver = null;
            this._renderLimit += this.ROWS_PER_PAGE;
            app.render();
        }, { root: container, rootMargin: '600px 0px' });

        observer.observe(sentinel);
        this._rowObserver = observer;
    },

    // Any view that overwrites #email-container (drafts, empty states) must
    // drop the observer — it would otherwise hold a detached sentinel.
    teardownListSentinel() {
        this._rowObserver?.disconnect();
        this._rowObserver = null;
    },

    renderViewer(email, app) {
        this.setViewerEmpty(false);
        // Identity row: split "Name <addr>" so the name leads and the address
        // reads as quiet metadata; the avatar carries the sender's initial.
        const rawFrom = String(email.from || 'Unknown');
        const fromMatch = rawFrom.match(/^\s*"?([^"<]*)"?\s*<([^>]+)>\s*$/);
        const fromName = (fromMatch && fromMatch[1].trim()) || (fromMatch ? fromMatch[2].trim() : rawFrom);
        const fromAddr = fromMatch ? fromMatch[2].trim() : '';
        const avatar = document.getElementById('email-viewer-avatar');
        if (avatar) avatar.textContent = ((fromName.match(/[a-zA-Z0-9]/) || ['?'])[0]).toUpperCase();
        document.getElementById('email-viewer-from').innerHTML =
            `<span class="email-viewer-from-name">${UIUtils.escapeHtml(fromName)}</span>` +
            (fromAddr ? `<span class="email-viewer-from-addr">&lt;${UIUtils.escapeHtml(fromAddr)}&gt;</span>` : '');
        document.getElementById('email-viewer-to').textContent = `to ${email.to || ''}`;
        document.getElementById('email-viewer-subject').textContent = email.subject || '(no subject)';
        document.getElementById('email-viewer-date').textContent = new Date(email.date).toLocaleString([], {
            month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit'
        });

        this.renderViewerAttachments(email);

        // Body is loaded lazily (it lives in a separate table). If it isn't on
        // the object yet, show a placeholder; openViewer fetches it and calls
        // renderViewerBody once it arrives.
        if (email.bodyHtml == null && email.bodyText == null) {
            const bodyEl = document.getElementById('email-viewer-body');
            bodyEl.style.whiteSpace = 'pre-wrap';
            bodyEl.textContent = email.snippet || 'Loading…';
        } else {
            this.renderViewerBody(email);
        }

        const bundleBtn = document.getElementById('email-viewer-bundle-btn');
        if (bundleBtn) {
            bundleBtn.onclick = () => this.showBundlePicker(email, app);
        }

        // Show/hide transaction button for brokerage emails. Also gated on the
        // AI Email Insights master switch — extracting transactions is an AI
        // call, so disabling insights hides this entry point too.
        const txnBtn = document.getElementById('email-viewer-transaction-btn');
        const isBrokerage = app.isBrokerageEmail(email);
        txnBtn.style.display = (isBrokerage && app.aiInsightsEnabled) ? '' : 'none';
        if (isBrokerage && app.hasTransactionFromEmail(email.messageId)) {
            txnBtn.innerHTML = 'Synced &#10003;';
        } else {
            txnBtn.textContent = 'Create Transaction';
        }

        // Render analysis section
        this.renderEmailAnalysis(email, app);
    },

    // Attachment chips above the body — click saves the file (bytes are
    // fetched on demand; only metadata lives on the email record). Hidden
    // while attachments are unknown (older cache) or absent.
    renderViewerAttachments(email) {
        const wrap = document.getElementById('email-viewer-attachments');
        if (!wrap) return;
        const atts = Array.isArray(email.attachments) ? email.attachments : [];
        if (atts.length === 0) {
            wrap.hidden = true;
            wrap.innerHTML = '';
            return;
        }
        const esc = UIUtils.escapeHtml;
        const fmtSize = (b) => b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB`
            : b >= 1024 ? `${Math.round(b / 1024)} KB` : `${b} B`;
        wrap.hidden = false;
        wrap.innerHTML = atts.map((a, i) => `
            <button type="button" class="email-viewer-attachment" data-att-index="${i}" title="Save to disk">
                <span class="email-viewer-attachment-icon" aria-hidden="true">&#128206;</span>
                <span class="email-viewer-attachment-name">${esc(a.filename || 'attachment')}</span>
                ${a.size ? `<span class="email-viewer-attachment-size">${fmtSize(a.size)}</span>` : ''}
            </button>`).join('');
        wrap.querySelectorAll('.email-viewer-attachment').forEach(btn => {
            btn.addEventListener('click', () => {
                const att = atts[Number(btn.dataset.attIndex)];
                if (att) EmailApp.saveViewerAttachment(email, att);
            });
        });
    },

    // Renders only the message body into #email-viewer-body. Split out so it can
    // run synchronously when the body is already in memory, or be called again
    // after the lazy body fetch resolves.
    renderViewerBody(email) {
        const bodyEl = document.getElementById('email-viewer-body');
        if (email.bodyHtml) {
            bodyEl.style.whiteSpace = '';
            const sanitized = window.electronEmail.sanitizeHtml(email.bodyHtml);
            const iframe = document.createElement('iframe');
            // Strict sandbox: allow-same-origin for height calc, block scripts/forms/popups/navigation
            iframe.sandbox = 'allow-same-origin';
            iframe.style.cssText = 'width: 100%; border: none; min-height: 200px;';
            iframe.referrerPolicy = 'no-referrer';
            iframe.setAttribute('scrolling', 'no');
            bodyEl.innerHTML = '';
            bodyEl.appendChild(iframe);

            iframe.addEventListener('load', () => {
                const doc = iframe.contentDocument;
                if (doc) {
                    doc.open();
                    doc.write(sanitized);
                    doc.close();
                    doc.body.style.margin = '0';
                    // The viewer pane owns scrolling and the iframe is sized
                    // to its content — its own scrollbar is a dead second bar
                    // painted inside the email.
                    doc.documentElement.style.overflow = 'hidden';

                    // Rewrite all links to open in default browser
                    doc.querySelectorAll('a[href]').forEach(a => {
                        const href = a.getAttribute('href');
                        a.removeAttribute('href');
                        a.removeAttribute('target');
                        a.style.cursor = 'pointer';
                        a.dataset.href = href;
                    });
                    doc.addEventListener('click', (e) => {
                        const a = e.target.closest('a[data-href]');
                        if (a) {
                            e.preventDefault();
                            const href = a.dataset.href;
                            if (href && (href.startsWith('http://') || href.startsWith('https://'))) {
                                window.electronEmail.openExternal(href);
                            }
                        }
                    });

                    // Auto-resize iframe to fit content, re-check as images load
                    const resizeIframe = () => {
                        iframe.style.height = doc.body.scrollHeight + 'px';
                    };
                    resizeIframe();
                    // Re-measure after images and styles finish loading
                    doc.querySelectorAll('img').forEach(img => {
                        if (!img.complete) img.addEventListener('load', resizeIframe);
                    });
                    // Observe DOM/layout changes for late-loading content
                    if (typeof ResizeObserver !== 'undefined') {
                        const ro = new ResizeObserver(resizeIframe);
                        ro.observe(doc.body);
                    }
                }
            });
            iframe.src = 'about:blank';
        } else {
            bodyEl.style.whiteSpace = 'pre-wrap';
            bodyEl.textContent = email.bodyText || email.snippet || '';
        }
    },

    renderEmailAnalysis(email, app) {
        const container = document.getElementById('email-viewer-analysis');
        if (!container) return;

        const analysis = app.priorityAnalyses[email.messageId];
        if (!analysis) {
            container.innerHTML = '';
            container.style.display = 'none';
            return;
        }

        container.style.display = '';

        const priorityClass = `analysis-priority-${analysis.priority || 'medium'}`;

        let actionItemsHtml = '';
        if (analysis.actionItems?.length > 0) {
            actionItemsHtml = `
                <div class="analysis-section">
                    <h4 class="analysis-section-title">Action Items</h4>
                    <ul class="analysis-action-list">
                        ${analysis.actionItems.map(item => `
                            <li class="analysis-action-item">
                                <span class="analysis-action-text">${UIUtils.escapeHtml(UIUtils.humanizeIsoDates(item.text))}</span>
                                ${item.dueDate && item.dueDate !== 'null' ? `<span class="analysis-due-date">Due: ${UIUtils.escapeHtml(UIUtils.humanizeIsoDates(item.dueDate))}</span>` : ''}
                            </li>
                        `).join('')}
                    </ul>
                </div>
            `;
        }

        let insightsHtml = '';
        if (analysis.insights?.length > 0) {
            insightsHtml = `
                <div class="analysis-section">
                    <h4 class="analysis-section-title">Key Insights</h4>
                    <ul class="analysis-insights-list">
                        ${analysis.insights.map(i => `<li>${UIUtils.escapeHtml(i)}</li>`).join('')}
                    </ul>
                </div>
            `;
        }

        container.innerHTML = `
            <div class="email-analysis ${priorityClass}">
                <div class="analysis-header">
                    <span class="analysis-title">AI Analysis</span>
                    ${this.insightTypeChip(analysis)}
                    <span class="analysis-priority-badge">${UIUtils.escapeHtml(analysis.priority || 'medium')}</span>
                    <span class="analysis-timestamp">${new Date(analysis.analyzedAt).toLocaleString()}</span>
                </div>
                ${analysis.summary ? `<p class="analysis-summary">${UIUtils.escapeHtml(UIUtils.humanizeIsoDates(analysis.summary))}</p>` : ''}
                ${actionItemsHtml}
                ${insightsHtml}
                ${this.insightActionsRow(email, app)}
            </div>
        `;
        this.bindInsightActions(container, app);
    },

    // Small type chip (e.g. "Renewal", "Payment") for an analysis. Hidden for
    // legacy analyses with no type and for plain 'general'.
    insightTypeChip(analysis) {
        const type = analysis?.type;
        if (!type || type === 'general') return '';
        const label = EmailApp.INSIGHT_TYPE_LABELS[type] || type;
        return `<span class="insight-type-chip insight-type-${type}">${UIUtils.escapeHtml(label)}</span>`;
    },

    // Feedback + curation row: Useful / Not useful tune the learning loop;
    // Follow / Mute manage the sender directly.
    insightActionsRow(email, app) {
        const followed = app.isPrioritySender(email);
        const hasTask = app.emailHasTask(email.messageId);
        const taskBtn = hasTask
            ? '<span class="insight-fb-added" title="A task from this email is in Tasks">&#10003; Task added</span>'
            : '<button class="insight-fb-btn insight-fb-addtask" data-fb="addtask" title="Create a task in Tasks from this email">&#43; Add task</button>';
        return `
            <div class="insight-feedback-row" data-email-id="${email.messageId}">
                ${taskBtn}
                <button class="insight-fb-btn insight-fb-vote" data-fb="useful" title="Helpful — keep surfacing this kind of insight from this sender">&#128077; Useful</button>
                <button class="insight-fb-btn insight-fb-vote" data-fb="not-useful" title="Not helpful — dismiss, and stop showing this kind of insight from this sender">&#128078; Not useful</button>
                <span class="insight-fb-spacer"></span>
                ${followed
                    ? '<span class="insight-fb-followed" title="This sender is always analyzed">&#10003; Following</span>'
                    : '<button class="insight-fb-btn insight-fb-manage" data-fb="follow" title="Always analyze this sender">Follow sender</button>'}
                <button class="insight-fb-btn insight-fb-manage" data-fb="mute" title="Never analyze this sender">Mute</button>
            </div>
        `;
    },

    // Wire the feedback/curation buttons inside a container (viewer or card).
    bindInsightActions(container, app) {
        container.querySelectorAll('.insight-feedback-row').forEach(row => {
            const emailId = row.dataset.emailId;
            row.querySelectorAll('.insight-fb-btn').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const fb = btn.dataset.fb;

                    if (fb === 'useful' || fb === 'not-useful') {
                        const useful = fb === 'useful';
                        // Immediate visual ack: mark the chosen button selected
                        // and lock the pair so the vote can't be inflated.
                        row.querySelectorAll('[data-fb="useful"],[data-fb="not-useful"]')
                            .forEach(b => { b.disabled = true; });
                        btn.classList.add('is-selected');

                        app.recordInsightFeedback(emailId, useful);

                        if (!useful) {
                            // "Not useful" dismisses THIS insight (marks it read so
                            // it leaves the unread set) and teaches the system to
                            // stop surfacing this kind of insight from this sender
                            // — it does not silence the sender's other insights.
                            app.markAnalysisRead(emailId, true);
                            this._refreshInsightSurface(container, app, emailId);
                        }
                        // "Useful" just records the vote — the selected state and
                        // toast are the acknowledgement; no re-render needed.
                        return;
                    }

                    if (fb === 'addtask') {
                        app.addTaskFromInsight(emailId);
                        // Reflect the new task (button flips to "Task added").
                        this._refreshInsightSurface(container, app, emailId);
                        return;
                    }

                    if (fb === 'follow') {
                        app.followSenderOf(emailId);
                        this._refreshInsightSurface(container, app, emailId);
                    } else if (fb === 'mute') {
                        app.muteSenderOf(emailId);
                        // Muting a sender also dismisses the current insight.
                        app.markAnalysisRead(emailId, true);
                        this._refreshInsightSurface(container, app, emailId);
                    }
                });
            });
        });
    },

    // Re-render whichever surface the feedback row lives in so follow/mute
    // state and read/dismiss state stay in sync after an action.
    _refreshInsightSurface(container, app, emailId) {
        if (container.id === 'email-viewer-analysis') {
            const email = app.emails.find(e => e.messageId === emailId);
            if (email) this.renderEmailAnalysis(email, app);
        } else if (app.currentView === 'insight-detail' && app.currentInsightId === emailId) {
            this.renderInsightDetail(app, container.id === 'email-insights-content' ? undefined : container.id);
        } else {
            this.renderInsightsList(app, container.id === 'email-insights-content' ? undefined : container.id);
        }
    },

    // Full-page detail for one insight — Insights rows and the home feed's
    // insight cards both land here. Reuses the feedback row and action-item
    // rows the accordion detail used to render inline.
    renderInsightDetail(app, containerId) {
        const container = document.getElementById(containerId || 'email-insights-content');
        if (!container) return;
        const emailId = app.currentInsightId;
        const analysis = app.priorityAnalyses[emailId];
        const email = app.emails.find(e => e.messageId === emailId);
        if (!analysis || !email) { app.showInsights(); return; }

        const esc = UIUtils.escapeHtml;
        const actions = analysis.actionItems || [];
        const priorityClass = analysis.priority === 'high' ? 'high' : analysis.priority === 'low' ? 'low' : 'medium';
        const timeAgo = app.formatTimeAgo(email.date || new Date(parseInt(email.internalDate)).toISOString());
        const eventDate = analysis.eventDate && analysis.eventDate !== 'null' ? analysis.eventDate : null;
        const isRead = !!analysis.readAt;
        const chips = [];
        if (analysis.type && analysis.type !== 'general') {
            chips.push(`<span class="insight-type-chip insight-type-${analysis.type}">${esc(analysis.type[0].toUpperCase() + analysis.type.slice(1))}</span>`);
        }
        if (analysis.amount && analysis.amount !== 'null') chips.push(`<span class="insight-detail-meta-chip">${esc(analysis.amount)}</span>`);
        if (eventDate) chips.push(`<span class="insight-detail-meta-chip">${esc(this.formatDate(eventDate + 'T00:00:00'))}</span>`);

        // The wrapper is what carries the reading measure — the back link has
        // to ride the same column as the card, or centering the card alone
        // strands the link out at the far left of a wide window.
        container.innerHTML = `
            <div class="insight-detail-main">
            <button class="insight-detail-back" type="button">&larr; AI Insights</button>
            <article class="insight-detail-page">
                <header class="insight-detail-head">
                    <div class="insight-detail-chips">
                        <span class="insight-row-dot insight-dot-${priorityClass}" title="${analysis.priority || 'medium'} priority"></span>
                        ${chips.join('')}
                    </div>
                    <h2 class="insight-detail-title">${esc(UIUtils.humanizeIsoDates(email.subject) || '(no subject)')}</h2>
                    <div class="insight-detail-sub">${esc(this.extractName(email.from))} &middot; ${esc(timeAgo)}</div>
                </header>
                ${analysis.summary ? `<p class="insight-detail-lede">${esc(UIUtils.humanizeIsoDates(analysis.summary))}</p>` : ''}
                ${actions.length ? `
                    <div class="insight-detail-section-label">Action items</div>
                    <div class="insight-card-actions">
                        ${actions.map(item => {
                            const dueDate = item.dueDate && item.dueDate !== 'null' ? item.dueDate : null;
                            const taskId = app.taskIdForAction(email, item.text);
                            return `<div class="insight-action-row${taskId ? ' insight-action-linked' : ''}"${taskId ? ` data-task-id="${taskId}" role="button" title="Open this task"` : ''}>
                                <span class="insight-action-check">&#9675;</span>
                                <div class="insight-action-content">
                                    <span class="insight-action-text">${esc(UIUtils.humanizeIsoDates(item.text))}</span>
                                    ${dueDate ? `<span class="insight-action-due">Due ${esc(UIUtils.humanizeIsoDates(dueDate))}</span>` : ''}
                                </div>
                                ${taskId ? `<span class="insight-action-open">Open task &#8594;</span>` : ''}
                            </div>`;
                        }).join('')}
                    </div>` : ''}
                ${this.insightMatterTimeline(emailId, app)}
                ${this.insightActionsRow(email, app)}
                <div class="insight-detail-footer">
                    <button class="insight-open-email" data-id="${esc(email.messageId)}">Open email &#8594;</button>
                    <button class="insight-mark-read-btn insight-detail-read-btn" data-email-id="${esc(email.messageId)}" title="${isRead ? 'Mark as unread' : 'Mark as read'}">${isRead ? 'Mark unread' : '&#10003; Done'}</button>
                </div>
            </article>
            </div>`;

        container.querySelector('.insight-detail-back').addEventListener('click', () => app.showInsights());
        this.bindInsightActions(container, app);
        container.querySelectorAll('.insight-action-row[data-task-id]').forEach(row => {
            row.addEventListener('click', (e) => {
                e.stopPropagation();
                app.openTaskFromInsight(row.dataset.taskId);
            });
        });
        container.querySelector('.insight-open-email')?.addEventListener('click', () => {
            app.openViewer(emailId);
        });
        container.querySelectorAll('.insight-matter-summary').forEach(el => {
            el.addEventListener('click', () => {
                app.openViewer(el.closest('[data-member-id]').dataset.memberId);
            });
        });
        container.querySelectorAll('.insight-matter-unfold').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (!app.unfoldFromMatter(emailId, btn.dataset.memberId)) return;
                UIUtils.showToast('Split out as its own insight', 'success');
                this.renderInsightDetail(app, containerId);
            });
        });
        container.querySelector('.insight-detail-read-btn')?.addEventListener('click', () => {
            const read = !!app.priorityAnalyses[emailId]?.readAt;
            app.markAnalysisRead(emailId, !read);
            this.renderInsightDetail(app, containerId);
        });
    },

    /**
     * The earlier notices about the same matter, oldest first. This is what
     * makes hiding rolled-up members honest: every one of them is here, with
     * its own summary and date, a link to the message, and a way to split it
     * back out if the grouping was wrong.
     */
    insightMatterTimeline(headMessageId, app) {
        const timeline = app.matterTimeline(headMessageId);
        if (!timeline.length) return '';
        const esc = UIUtils.escapeHtml;
        return `
            <div class="insight-detail-section-label">Earlier about this (${timeline.length})</div>
            <div class="insight-matter-timeline">
                ${timeline.map(({ email, analysis, stored }) => {
                    const when = this.formatDate(stored.at || email.date) || '';
                    const line = analysis.summary || stored.summary || email.subject || '';
                    return `<div class="insight-matter-row" data-member-id="${esc(email.messageId)}">
                        <span class="insight-matter-when">${esc(when)}</span>
                        <span class="insight-matter-summary" role="button" title="Open this email">${esc(UIUtils.humanizeIsoDates(line))}</span>
                        <button class="insight-matter-unfold" data-member-id="${esc(email.messageId)}" title="Not the same thing — show this on its own">Not this</button>
                    </div>`;
                }).join('')}
            </div>`;
    },

    renderLabels(app) {
        const container = document.getElementById('email-label-list');
        if (!container) return;

        const emails = app.getScopedEmails();
        const analyses = app.getProfileAnalyses(new Set(emails.map(e => e.messageId)));

        // AI Insights nav item at the top. The badge is an UNREAD count (like
        // Inbox) — analyses gain a readAt when viewed or dismissed — so it
        // clears once everything has been read, not the all-time total.
        const insightsCount = Object.values(analyses).filter(a => a && !a.readAt).length;
        let html = `
            <div class="email-label-item email-label-insights ${app.currentView === 'insights' || app.currentView === 'insight-detail' ? 'active' : ''}" data-view="insights">
                <span class="email-label-name">&#9672; AI Insights</span>
                ${insightsCount > 0 ? `<span class="email-label-count">${insightsCount}</span>` : ''}
                <button class="email-insights-settings-btn" data-action="insights-settings" title="Insights settings" aria-label="Insights settings">&#9881;</button>
            </div>
        `;

        const displayLabels = ['INBOX', 'PRIORITY', 'SENT', 'DRAFTS', 'IMPORTANT', 'ARCHIVE', 'TRASH'];

        // Unread badges only — total counts were a second mystery number next
        // to the badge and said nothing actionable. Exception: Drafts shows
        // its count (drafts have no unread state; the number IS the signal).
        html += displayLabels.map(label => {
            let unreadCount = 0;
            let draftCount = 0;

            if (label === 'PRIORITY') {
                unreadCount = emails.filter(e => app.isPrioritySender(e) && (e.labels || []).includes('INBOX') && !e.isRead).length;
            } else if (label === 'INBOX') {
                unreadCount = emails.filter(e => (e.labels || []).includes('INBOX') && !e.isRead).length;
            } else if (label === 'DRAFTS') {
                // Drafts live server-side, not in the local emails table, so a
                // label filter would always show 0. Use the fetched list count.
                draftCount = app.getScopedDrafts().length;
            }

            const labelName = label === 'PRIORITY' ? 'Priority' : label.charAt(0) + label.slice(1).toLowerCase();
            const isActive = (label === 'DRAFTS' && app.currentView === 'drafts') ||
                (app.currentView === 'emails' && app.currentLabel === label);

            return `
                <div class="email-label-item ${isActive ? 'active' : ''} ${label === 'PRIORITY' ? 'email-label-priority' : ''}" data-label="${label}">
                    <span class="email-label-name">${labelName}</span>
                    ${unreadCount > 0 ? `<span class="email-label-badge">${unreadCount}</span>` : ''}
                    ${draftCount > 0 ? `<span class="email-label-count">${draftCount}</span>` : ''}
                </div>
            `;
        }).join('');

        container.innerHTML = html;

        // AI Insights click handler
        container.querySelector('[data-view="insights"]')?.addEventListener('click', () => {
            app.showInsights();
        });

        // Gear → Insights settings. Stop propagation so it doesn't also trigger
        // the nav item's switch-to-insights handler above.
        container.querySelector('[data-action="insights-settings"]')?.addEventListener('click', (e) => {
            e.stopPropagation();
            app.showPrioritySettings();
        });

        container.querySelectorAll('.email-label-item[data-label]').forEach(item => {
            item.addEventListener('click', () => {
                if (item.dataset.label === 'DRAFTS') {
                    app.showDrafts();
                } else {
                    app.currentLabel = item.dataset.label;
                    app.currentView = 'emails';
                    app.currentBundle = null;
                    app.render();
                }
            });
        });
    },

    renderDrafts(app) {
        const container = document.getElementById('email-container');
        const emptyState = document.getElementById('email-empty');
        const toolbar = document.querySelector('#email-list-section .app-toolbar');
        if (!container) return;

        // The shared #email-empty element is styled for the inbox empty state.
        // Render our own placeholder inside #email-container so we don't have
        // to mutate its DOM and risk breaking other views.
        this.teardownListSentinel();
        this.renderBundleBar(null);
        if (emptyState) emptyState.style.display = 'none';
        if (toolbar) toolbar.style.display = '';

        const drafts = app.getScopedDrafts();
        if (app.draftsLoading && drafts.length === 0) {
            container.style.display = '';
            container.innerHTML = '<div class="email-drafts-placeholder">Loading drafts…</div>';
            return;
        }

        if (drafts.length === 0) {
            container.style.display = '';
            container.innerHTML = '<div class="email-drafts-placeholder">No drafts.</div>';
            return;
        }

        container.style.display = '';

        container.innerHTML = drafts.map(d => {
            const to = d.to || '(No recipient)';
            const subject = d.subject || '(no subject)';
            const snippet = d.snippet || '';
            const date = this.formatDate(d.date);
            return `
                <div class="email-row email-draft-row" data-draft-id="${d.draftId}" data-account="${UIUtils.escapeHtml(d.account)}">
                    <div class="email-row-indicators"></div>
                    <div class="email-row-from">To: ${UIUtils.escapeHtml(to)}</div>
                    <div class="email-row-content">
                        <span class="email-row-subject">${UIUtils.escapeHtml(subject)}</span>
                        <span class="email-row-snippet"> &mdash; ${UIUtils.escapeHtml(snippet)}</span>
                    </div>
                    <div class="email-row-date">${date}</div>
                </div>
            `;
        }).join('');

        container.querySelectorAll('.email-draft-row').forEach(row => {
            row.addEventListener('click', () => {
                app.openDraft(row.dataset.draftId, row.dataset.account);
            });
        });
    },

    renderAccounts(app) {
        const container = document.getElementById('email-accounts-list');
        if (!container) return;

        const accounts = app.getAccounts();
        const manageLinkHtml = `
            <button class="email-accounts-manage-link" id="email-accounts-manage-link">
                Manage accounts in Settings &rsaquo;
            </button>
        `;

        if (accounts.length === 0) {
            container.innerHTML = manageLinkHtml;
        } else if (accounts.length === 1) {
            // Nothing to switch between — read-only display. All
            // connect/disconnect/reconnect actions live in Settings.
            container.innerHTML = `
                <div class="email-account-item">
                    <span class="email-account-email">${UIUtils.escapeHtml(accounts[0].email)}</span>
                </div>
            ` + manageLinkHtml;
        } else {
            // Scope switcher: "All accounts" + one row per account. Badges are
            // unread INBOX counts — same semantics as the Inbox label badge —
            // so the switcher is informative even when never clicked.
            const emails = app.getProfileEmails();
            const unreadFor = (acct) => emails.filter(e =>
                (!acct || e.account === acct) &&
                (e.labels || []).includes('INBOX') && !e.isRead).length;

            const rowHtml = (acctEmail, label) => {
                const active = (app.currentAccount || '') === acctEmail;
                const unread = unreadFor(acctEmail);
                const safe = UIUtils.escapeHtml(acctEmail);
                return `
                    <div class="email-label-item email-account-scope ${active ? 'active' : ''}"
                         data-account="${safe}" ${acctEmail ? `title="${safe}"` : ''}>
                        <span class="email-label-name email-account-scope-name">${UIUtils.escapeHtml(label)}</span>
                        ${unread > 0 ? `<span class="email-label-badge">${unread}</span>` : ''}
                    </div>
                `;
            };

            container.innerHTML = rowHtml('', 'All accounts') +
                accounts.map(a => rowHtml(a.email, a.email)).join('') +
                manageLinkHtml;

            container.querySelectorAll('.email-account-scope').forEach(item => {
                item.addEventListener('click', () => {
                    const acct = item.dataset.account || null;
                    // Clicking the already-active account returns to All.
                    app.setAccountScope(acct === app.currentAccount ? null : acct);
                });
            });
        }

        const manageLink = document.getElementById('email-accounts-manage-link');
        if (manageLink) {
            manageLink.addEventListener('click', () => { AppManager.openApp('settings'); setTimeout(() => SettingsApp.openCategory('accounts'), 50); });
        }
    },

    // Renders all three sections of the AI Insights settings view.
    renderInsightSettings(app) {
        // 1. Insight-type checkboxes
        const typesEl = document.getElementById('email-insight-types');
        if (typesEl) {
            const enabled = app.insightSettings.enabledTypes;
            const autoOn = app.insightSettings.autoDetect;
            typesEl.innerHTML = app.INSIGHT_TYPES.map(type => `
                <label class="insight-type-toggle ${autoOn ? '' : 'is-disabled'}">
                    <input type="checkbox" data-insight-type="${type}" ${enabled[type] ? 'checked' : ''} ${autoOn ? '' : 'disabled'}>
                    <span class="insight-type-label">${UIUtils.escapeHtml(app.INSIGHT_TYPE_LABELS[type] || type)}</span>
                </label>
            `).join('');
            typesEl.querySelectorAll('input[data-insight-type]').forEach(cb => {
                cb.addEventListener('change', () => {
                    app.toggleInsightType(cb.dataset.insightType, cb.checked);
                });
            });
        }

        // 2. Followed senders + 3. Muted senders
        this.renderPriorityTerms(app);
        this.renderMutedSenders(app);

        // 4. Bundles + 5. Bundle rules
        this.renderBundleSettings(app);
    },

    // Renders the Bundles section (toggle/add/delete bundles, re-classify)
    // and the sender→bundle rules list of the settings view.
    renderBundleSettings(app) {
        const defsEl = document.getElementById('email-bundle-defs');
        if (defsEl) {
            const hidden = new Set(app.bundleConfig.hidden || []);
            const customKeys = new Set((app.bundleConfig.custom || []).map(d => d.key));
            // Two-line cards: the description is what the AI actually matches
            // on, so it belongs on the card, not in a tooltip. Off bundles dim
            // rather than disappear.
            defsEl.innerHTML = app.allBundleDefs().map(d => `
                <label class="bundle-def-card ${hidden.has(d.key) ? 'is-off' : ''}">
                    <input type="checkbox" data-bundle-key="${UIUtils.escapeHtml(d.key)}" ${hidden.has(d.key) ? '' : 'checked'}>
                    <span class="bundle-def-text">
                        <span class="bundle-def-name">
                            ${UIUtils.escapeHtml(d.label)}
                            ${customKeys.has(d.key) ? '<span class="bundle-def-tag">Yours</span>' : ''}
                        </span>
                        ${d.desc ? `<span class="bundle-def-desc" title="${UIUtils.escapeHtml(d.desc)}">${UIUtils.escapeHtml(d.desc)}</span>` : ''}
                    </span>
                    ${customKeys.has(d.key) ? `<button class="priority-term-delete bundle-def-delete" data-bundle-key="${UIUtils.escapeHtml(d.key)}" title="Delete bundle" aria-label="Delete ${UIUtils.escapeHtml(d.label)}">&times;</button>` : ''}
                </label>
            `).join('');
            defsEl.querySelectorAll('input[data-bundle-key]').forEach(cb => {
                cb.addEventListener('change', () => {
                    app.toggleBundleHidden(cb.dataset.bundleKey, !cb.checked);
                    // Dim in place instead of re-rendering, so the checkbox
                    // keeps focus for keyboard runs down the list.
                    cb.closest('.bundle-def-card')?.classList.toggle('is-off', !cb.checked);
                });
            });
            defsEl.querySelectorAll('.bundle-def-delete').forEach(btn => {
                btn.addEventListener('click', async (e) => {
                    e.preventDefault();
                    const key = btn.dataset.bundleKey;
                    const ok = await UIUtils.confirm('Delete Bundle',
                        `Delete the "${app.bundleLabel(key)}" bundle? Its emails will be re-classified into the remaining bundles.`, '');
                    if (!ok) return;
                    app.removeCustomBundle(key);
                    this.renderBundleSettings(app);
                });
            });
        }

        const addBtn = document.getElementById('email-bundle-add-btn');
        if (addBtn) {
            addBtn.onclick = () => {
                const nameEl = document.getElementById('email-bundle-name');
                const descEl = document.getElementById('email-bundle-desc');
                const res = app.addCustomBundle(nameEl?.value, descEl?.value);
                if (res.error) { UIUtils.showToast(res.error, 'error'); return; }
                if (nameEl) nameEl.value = '';
                if (descEl) descEl.value = '';
                UIUtils.showToast('Bundle added — mail will start classifying into it', 'success');
                this.renderBundleSettings(app);
            };
        }

        const reBtn = document.getElementById('email-bundle-reclassify-btn');
        if (reBtn) reBtn.onclick = () => app.reclassifyBundles();

        // Keyword filter for the rules list — `oninput =` assignment keeps the
        // binding idempotent, and only the list re-renders so focus survives.
        const searchEl = document.getElementById('email-bundle-rules-search');
        if (searchEl) searchEl.oninput = () => this._renderBundleRulesList(app);
        this._renderBundleRulesList(app);
    },

    // The sender→bundle rules list, filtered by the search box (matches the
    // sender address or the target bundle's name).
    _renderBundleRulesList(app) {
        const rulesEl = document.getElementById('email-bundle-rules-list');
        if (!rulesEl) return;

        const all = Object.entries(app.bundleConfig.senderRules || {})
            .sort((a, b) => a[0].localeCompare(b[0]));
        if (all.length === 0) {
            rulesEl.innerHTML = '<p class="priority-empty">No rules yet. Use &#9776; &ldquo;Move to bundle&hellip;&rdquo; on an email and keep &ldquo;always for this sender&rdquo; checked to create one.</p>';
            return;
        }

        const q = (document.getElementById('email-bundle-rules-search')?.value || '').trim().toLowerCase();
        const targetOf = (key) => key === 'none' ? 'Never bundled' : app.bundleLabel(key);
        const rules = q
            ? all.filter(([addr, key]) =>
                addr.toLowerCase().includes(q) || targetOf(key).toLowerCase().includes(q))
            : all;

        if (rules.length === 0) {
            rulesEl.innerHTML = `<p class="priority-empty">No rules match &ldquo;${UIUtils.escapeHtml(q)}&rdquo;.</p>`;
            return;
        }

        rulesEl.innerHTML = rules.map(([addr, key]) => {
            const initial = (addr.trim()[0] || '?').toUpperCase();
            const target = targetOf(key);
            return `<div class="sender-row">
                <span class="sender-avatar" aria-hidden="true">${UIUtils.escapeHtml(initial)}</span>
                <span class="sender-row-name" title="${UIUtils.escapeHtml(addr)}">${UIUtils.escapeHtml(addr)}</span>
                <span class="bundle-rule-target">&rarr; ${UIUtils.escapeHtml(target)}</span>
                <button class="priority-term-delete bundle-rule-remove" data-addr="${UIUtils.escapeHtml(addr)}" title="Remove rule" aria-label="Remove rule for ${UIUtils.escapeHtml(addr)}">&times;</button>
            </div>`;
        }).join('');
        rulesEl.querySelectorAll('.bundle-rule-remove').forEach(btn => {
            btn.addEventListener('click', () => {
                app.removeSenderBundleRule(btn.dataset.addr);
                this._renderBundleRulesList(app);
            });
        });
    },

    renderMutedSenders(app) {
        const container = document.getElementById('email-muted-senders-list');
        if (!container) return;
        const muted = app.insightSettings.mutedSenders || [];
        if (muted.length === 0) {
            container.innerHTML = '<p class="priority-empty">No muted senders.</p>';
            return;
        }
        container.innerHTML = muted.map(addr => {
            const initial = (addr.trim()[0] || '?').toUpperCase();
            return `<div class="sender-row" data-addr="${UIUtils.escapeHtml(addr)}">
                <span class="sender-avatar" aria-hidden="true">${UIUtils.escapeHtml(initial)}</span>
                <span class="sender-row-name" title="${UIUtils.escapeHtml(addr)}">${UIUtils.escapeHtml(addr)}</span>
                <button class="priority-term-delete muted-sender-remove" data-addr="${UIUtils.escapeHtml(addr)}" title="Unmute" aria-label="Unmute ${UIUtils.escapeHtml(addr)}">&times;</button>
            </div>`;
        }).join('');
        container.querySelectorAll('.muted-sender-remove').forEach(btn => {
            btn.addEventListener('click', () => {
                app.unmuteSender(btn.dataset.addr);
                this.renderMutedSenders(app);
            });
        });
    },

    async renderPriorityTerms(app) {
        const container = document.getElementById('email-priority-terms-list');
        if (!container) return;

        if (app.priorityTerms.length === 0) {
            container.innerHTML = '<p class="priority-empty">No followed senders yet. Add a name, email, or company above to always analyze their mail.</p>';
            return;
        }

        const categoryLabels = {
            general: 'General', brokerage: 'Brokerage', work: 'Work',
            kids: 'Kids', family: 'Family', health: 'Health', school: 'School'
        };

        // Flat, compact list sorted by category then name. The per-row category
        // selector is the single source of category truth — no redundant group
        // headers. Avatar initial gives a clean contact-list feel.
        const sorted = [...app.priorityTerms].sort((a, b) =>
            (a.category || 'general').localeCompare(b.category || 'general') ||
            a.term.localeCompare(b.term)
        );

        // Match counts come from a single SQL query rather than scanning every
        // in-memory email per term. Falls back to no counts if the DB call fails.
        let counts = {};
        try {
            const accounts = app.getAccounts().map(a => a.email);
            counts = (await window.electronEmailDb.countByFromTerms(accounts, sorted.map(t => t.term))) || {};
        } catch { /* counts stay empty — rows still render */ }

        const html = sorted.map(t => {
            const term = t.term;
            const initial = (term.trim()[0] || '?').toUpperCase();
            const count = counts[term] || 0;
            const options = app.SENDER_CATEGORIES.map(c =>
                `<option value="${c}" ${c === t.category ? 'selected' : ''}>${categoryLabels[c] || c}</option>`
            ).join('');
            return `<div class="sender-row" data-term="${UIUtils.escapeHtml(term)}">
                <span class="sender-avatar" aria-hidden="true">${UIUtils.escapeHtml(initial)}</span>
                <span class="sender-row-name" title="${UIUtils.escapeHtml(term)}">${UIUtils.escapeHtml(term)}</span>
                ${count > 0 ? `<span class="sender-row-count" title="${count} matching email${count === 1 ? '' : 's'}">${count}</span>` : ''}
                <select class="priority-term-category-select" data-term="${UIUtils.escapeHtml(term)}" aria-label="Category for ${UIUtils.escapeHtml(term)}">
                    ${options}
                </select>
                <button class="priority-term-delete" data-term="${UIUtils.escapeHtml(term)}" title="Remove" aria-label="Remove ${UIUtils.escapeHtml(term)}">&times;</button>
            </div>`;
        }).join('');

        container.innerHTML = html;

        container.querySelectorAll('.priority-term-delete').forEach(btn => {
            btn.addEventListener('click', () => {
                app.removePriorityTerm(btn.dataset.term);
            });
        });

        container.querySelectorAll('.priority-term-category-select').forEach(sel => {
            sel.addEventListener('change', () => {
                const entry = app.priorityTerms.find(t => t.term === sel.dataset.term);
                if (entry) {
                    entry.category = sel.value;
                    app.saveData();
                    this.renderPriorityTerms(app);
                }
            });
        });
    },

    _insightsReadPage: 0,
    INSIGHTS_PAGE_SIZE: 10,

    renderInsightsList(app, targetContainerId) {
        const container = document.getElementById(targetContainerId || 'email-insights-content');
        if (!container) return;

        // Build email lookup index once (O(n) instead of O(n*m) find calls) and
        // reuse it for getProfileAnalyses so we don't scan the email list twice.
        const profileEmails = app.getScopedEmails();
        const emailIndex = new Map();
        for (const email of profileEmails) {
            emailIndex.set(email.messageId, email);
        }

        // Collect and split into unread/read in a single pass
        const unread = [];
        const read = [];
        for (const [messageId, analysis] of Object.entries(app.getProfileAnalyses(new Set(emailIndex.keys())))) {
            const email = emailIndex.get(messageId);
            if (!email || !analysis) continue;
            // Rolled-up members of a matter aren't rows — they live in their
            // head's timeline (EmailApp._attachToMatter). Nothing is lost: the
            // head names the count and links each one.
            if (analysis.rolledUp) continue;
            (analysis.readAt ? read : unread).push({ email, analysis });
        }

        // Sort each group by date, newest first
        const byDate = (a, b) => new Date(b.email.date || b.email.internalDate || 0) - new Date(a.email.date || a.email.internalDate || 0);
        unread.sort(byDate);
        read.sort(byDate);

        if (unread.length === 0 && read.length === 0) {
            container.innerHTML = `
                <div class="insights-empty">
                    <div class="insights-empty-icon">&#9672;</div>
                    <h3>No insights yet</h3>
                    <p>Anjadhe automatically surfaces renewals, bills, appointments, deliveries, and other time-sensitive mail here &mdash; from followed senders and anything smart detection flags.</p>
                </div>
            `;
            return;
        }

        // Count totals (unread only)
        let totalActions = 0;
        let urgentCount = 0;
        for (const { analysis } of unread) {
            if (analysis.actionItems?.length) totalActions += analysis.actionItems.length;
            if (analysis.priority === 'high') urgentCount++;
        }

        const unreadOnly = app.showInsightsUnreadOnly !== false;

        let html = '';

        // Unread/All toggle — mirrors the Inbox toolbar. Unread hides the read
        // section entirely; All shows read insights expanded beneath the unread.
        html += `<div class="insights-toolbar">
            <div class="email-read-filter" role="tablist" aria-label="Show read or unread insights">
                <button class="email-filter-btn insights-filter-btn${unreadOnly ? ' is-active' : ''}" data-insights-filter="unread" type="button" role="tab">Unread</button>
                <button class="email-filter-btn insights-filter-btn${!unreadOnly ? ' is-active' : ''}" data-insights-filter="all" type="button" role="tab">All</button>
            </div>
        </div>`;

        // Summary strip
        html += `<div class="insights-summary-strip">
            <div class="insights-stat">
                <span class="insights-stat-num">${totalActions}</span>
                <span class="insights-stat-label">Action items</span>
            </div>
            <div class="insights-stat">
                <span class="insights-stat-num">${urgentCount}</span>
                <span class="insights-stat-label">High priority</span>
            </div>
            <div class="insights-stat">
                <span class="insights-stat-num">${unread.length}</span>
                <span class="insights-stat-label">Unread</span>
            </div>
        </div>`;

        // Compact one-line row; clicking it expands an inline detail panel
        // with the action items, feedback buttons, and a link to the email.
        const renderCard = ({ email, analysis }) => {
            const actions = analysis.actionItems || [];
            const priorityClass = analysis.priority === 'high' ? 'high' : analysis.priority === 'low' ? 'low' : 'medium';
            const timeAgo = app.formatTimeAgo(email.date || new Date(parseInt(email.internalDate)).toISOString());
            const isRead = !!analysis.readAt;
            const eventDate = analysis.eventDate && analysis.eventDate !== 'null' ? analysis.eventDate : null;
            const metaBits = [];
            if (analysis.amount && analysis.amount !== 'null') metaBits.push(analysis.amount);
            // Parse as local midnight — a bare YYYY-MM-DD would be read as UTC
            // and render a day early in negative-offset timezones.
            if (eventDate) metaBits.push(this.formatDate(eventDate + 'T00:00:00'));

            return `<div class="insight-item${isRead ? ' insight-read' : ''}" data-id="${email.messageId}">
                <div class="insight-row" role="button" title="Open this insight">
                    <span class="insight-row-dot insight-dot-${priorityClass}" title="${analysis.priority || 'medium'} priority"></span>
                    <span class="insight-row-from">${UIUtils.escapeHtml(this.extractName(email.from))}</span>
                    ${analysis.type && analysis.type !== 'general' ? `<span class="insight-type-chip insight-type-${analysis.type}">${UIUtils.escapeHtml(analysis.type[0].toUpperCase() + analysis.type.slice(1))}</span>` : ''}
                    <span class="insight-row-summary">${UIUtils.escapeHtml(UIUtils.humanizeIsoDates(analysis.summary || email.subject) || '(no subject)')}</span>
                    ${actions.length ? `<span class="insight-row-badge" title="${actions.length} action item${actions.length === 1 ? '' : 's'}">&#9744; ${actions.length}</span>` : ''}
                    ${analysis.matter?.count > 1 ? `<span class="insight-row-thread" title="${analysis.matter.count} emails about this, oldest ${this.formatDate(analysis.matter.firstAt) || ''}">${analysis.matter.count} emails</span>` : ''}
                    ${metaBits.length ? `<span class="insight-row-meta">${UIUtils.escapeHtml(metaBits.join(' · '))}</span>` : ''}
                    <span class="insight-row-time">${timeAgo}</span>
                    <button class="insight-mark-read-btn" data-email-id="${email.messageId}" title="${isRead ? 'Mark as unread' : 'Mark as read'}">${isRead ? 'Mark unread' : '&#10003; Done'}</button>
                </div>
            </div>`;
        };

        // Unread cards (always show all — these are the active items)
        if (unread.length === 0) {
            html += '<p class="insights-all-read">All caught up -- no unread insights.</p>';
        } else {
            html += unread.map(renderCard).join('');
        }

        // Read section (paginated). Hidden entirely under the "Unread" filter;
        // shown expanded under "All" so the toggle, not a second collapse, is
        // the single control over what's visible.
        if (!unreadOnly && read.length > 0) {
            const pageSize = this.INSIGHTS_PAGE_SIZE;
            const pageCount = Math.ceil(read.length / pageSize);
            const page = Math.min(this._insightsReadPage, pageCount - 1);
            this._insightsReadPage = page;
            const pageItems = read.slice(page * pageSize, (page + 1) * pageSize);

            html += `<div class="insights-read-section">
                <button class="insights-read-toggle" aria-expanded="true">
                    <span class="insights-read-toggle-label">Read (${read.length})</span>
                    <span class="insights-read-toggle-arrow">&#9652;</span>
                </button>
                <div class="insights-read-cards" style="display: block;">
                    ${pageItems.map(renderCard).join('')}
                    ${pageCount > 1 ? `
                        <div class="insights-pagination">
                            <button class="insights-page-btn insights-page-prev" ${page === 0 ? 'disabled' : ''}>&#8592; Newer</button>
                            <span class="insights-page-info">${page + 1} / ${pageCount}</span>
                            <button class="insights-page-btn insights-page-next" ${page >= pageCount - 1 ? 'disabled' : ''}>Older &#8594;</button>
                        </div>
                    ` : ''}
                </div>
            </div>`;
        }

        container.innerHTML = html;

        // Feedback / follow / mute buttons on each card
        this.bindInsightActions(container, app);

        // Store refs for pagination re-render
        const containerId = container.id;

        // Unread/All filter toggle
        container.querySelectorAll('[data-insights-filter]').forEach(btn => {
            btn.addEventListener('click', () => {
                const unread = btn.dataset.insightsFilter === 'unread';
                if (app.showInsightsUnreadOnly === unread) return;
                app.showInsightsUnreadOnly = unread;
                this._insightsReadPage = 0;
                app.saveData();
                this.renderInsightsList(app, containerId !== 'email-insights-content' ? containerId : undefined);
            });
        });

        // Toggle read section
        const toggle = container.querySelector('.insights-read-toggle');
        if (toggle) {
            toggle.addEventListener('click', () => {
                const cards = container.querySelector('.insights-read-cards');
                const arrow = toggle.querySelector('.insights-read-toggle-arrow');
                const expanded = cards.style.display !== 'none';
                cards.style.display = expanded ? 'none' : 'block';
                arrow.innerHTML = expanded ? '&#9662;' : '&#9652;';
                toggle.setAttribute('aria-expanded', !expanded);
            });
        }

        // Pagination buttons
        const prevBtn = container.querySelector('.insights-page-prev');
        const nextBtn = container.querySelector('.insights-page-next');
        if (prevBtn) {
            prevBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this._insightsReadPage = Math.max(0, this._insightsReadPage - 1);
                this.renderInsightsList(app, containerId !== 'email-insights-content' ? containerId : undefined);
                // Re-expand read section after re-render
                this._expandReadSection(container);
            });
        }
        if (nextBtn) {
            nextBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this._insightsReadPage++;
                this.renderInsightsList(app, containerId !== 'email-insights-content' ? containerId : undefined);
                this._expandReadSection(container);
            });
        }

        // A row opens the insight's full detail page (which marks it read,
        // like opening a message).
        container.querySelectorAll('.insight-item').forEach(item => {
            const rowEl = item.querySelector('.insight-row');
            if (!rowEl) return;
            rowEl.addEventListener('click', (e) => {
                if (e.target.closest('button')) return;
                app.showInsightDetail(item.dataset.id);
            });
        });

        // Action item → its schedule task's detail page
        container.querySelectorAll('.insight-action-row[data-task-id]').forEach(row => {
            row.addEventListener('click', (e) => {
                e.stopPropagation();
                app.openTaskFromInsight(row.dataset.taskId);
            });
        });

        // Open the underlying email from the expanded detail
        container.querySelectorAll('.insight-open-email').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                app.markAnalysisRead(btn.dataset.id, true);
                const insightsView = document.getElementById('email-insights-view');
                if (insightsView?.classList.contains('active')) {
                    insightsView.classList.remove('active');
                }
                app.openViewer(btn.dataset.id);
            });
        });

        // Mark as read/unread buttons
        container.querySelectorAll('.insight-mark-read-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const emailId = btn.dataset.emailId;
                const analysis = app.priorityAnalyses[emailId];
                if (!analysis) return;
                app.markAnalysisRead(emailId, !analysis.readAt);
                this.renderInsightsList(app, containerId !== 'email-insights-content' ? containerId : undefined);
            });
        });
    },

    _expandReadSection(container) {
        const readContainer = document.getElementById(container.id);
        if (!readContainer) return;
        const cards = readContainer.querySelector('.insights-read-cards');
        const arrow = readContainer.querySelector('.insights-read-toggle-arrow');
        if (cards) cards.style.display = 'block';
        if (arrow) arrow.innerHTML = '&#9652;';
        const toggle = readContainer.querySelector('.insights-read-toggle');
        if (toggle) toggle.setAttribute('aria-expanded', 'true');
    },

    renderMarkdown(text) {
        if (!text) return '';
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
            .replace(/\*(.+?)\*/g, '<em>$1</em>')
            .replace(/^### (.+)$/gm, '<h4>$1</h4>')
            .replace(/^## (.+)$/gm, '<h3>$1</h3>')
            .replace(/^# (.+)$/gm, '<h2>$1</h2>')
            .replace(/^- (.+)$/gm, '<li>$1</li>')
            .replace(/(<li>.*<\/li>)/s, '<ul>$1</ul>')
            .replace(/\n{2,}/g, '</p><p>')
            .replace(/\n/g, '<br>')
            .replace(/^/, '<p>')
            .replace(/$/, '</p>');
    }
};
