/**
 * Email Insights — its own app: everything the assistant found in email,
 * grouped by insight type.
 *
 * It was the Actions hub's "FYI" tab until 2026-08-03. Two changes on the
 * same day made a tab the wrong shape for it: membership widened to every
 * insight (see _items), and the strip it lived in emptied out when Goals
 * became a door off Tasks. It is about MAIL, not about the day's to-do
 * list, so it now sits beside Email in the registry rather than under
 * Actions. The app id, the view id, the CSS file and every storage key
 * stay `fyi` — ids are storage, labels are product (same call as `prompts`
 * for Routines and the `discover-` keys for News).
 *
 * The problem it solves (docs/LIFE_ORG.md): only action items reach
 * Actions. A flight, a renewal date, a statement closing, a package
 * arriving — all of it lives on the home widget, which is a burn-down
 * surface where reading an insight makes it disappear. That is correct
 * for a widget and wrong as the only home the information has.
 *
 * Two rules from the doc govern this page:
 *
 *   L1 — it organizes, it does not narrate. Rows show the extracted
 *        summary, type, date and amount. Nothing new is generated to
 *        render this page.
 *   L2 — reading does not consume. Unread is a MARK, not a filter; the
 *        Unread/All toggle defaults to All. A row leaves this page when
 *        it ages out of the window, not when it is looked at.
 *
 * **Membership is every insight in the window** (2026-08-03). It used to
 * exclude any insight that had become a task, which made this the page of
 * leftovers: an insight was here until it turned out to matter, and then
 * it left. The name changed with the rule — "FYI" described the remainder,
 * "Email Insights" describes the whole. An action item now appears in BOTH
 * places, and they answer different questions: Tasks is what you have to
 * do, this is what your mail said. See _items().
 *
 * Analyses are machine-local (SQLite email_analyses), so this page shows
 * what THIS Mac has analysed. That is the same contract as the Email
 * app's own insights list and the home widget.
 */

const FyiPage = {
    /**
     * How far back the page looks. Insights accumulate forever and nothing
     * prunes them, so without a window a "Bills & payments" group becomes
     * four hundred old statement notices — the firehose the insight system
     * exists to prevent. Anything older stays reachable through Email
     * search and Cmd+K.
     */
    RETENTION_DAYS: 90,

    // Selected type group; null = resolve to the first non-empty one.
    _type: null,
    // Account scope — null = all accounts. Mirrors the Inbox sidebar's
    // account switcher; only rendered when several accounts are connected.
    _account: null,
    // Unread/All toggle. Defaults to All (L2) — this is an organized view
    // of what was found, not an inbox to clear.
    _unreadOnly: false,
    // Message id of the insight open in the content pane. The detail lives
    // HERE, not in the Email app: an insight is a thing this page holds, and
    // sending the user to another app to read one loses the group they were
    // working through. Same shape as the Tasks tab's inline task detail —
    // the left nav stays up and clicking any type closes back to a list.
    _openId: null,
    // Set by openTo() before the page opens; consumed in init().
    _pendingOpenId: null,

    // Background email load, mirroring the home widget's kickLoad: EmailApp
    // is not initialised at startup, so the first paint of a session
    // usually has nothing in memory.
    _loading: false,
    _attempts: 0,
    MAX_ATTEMPTS: 3,

    init() {
        this._restoreViewState();
        // A deep link (the home widget's "Read") beats the restored
        // selection: it is what the user just asked for, and _restoreViewState
        // would otherwise put the previous one back over it.
        if (this._pendingOpenId) {
            this._openId = this._pendingOpenId;
            this._pendingOpenId = null;
            if (typeof EmailApp !== 'undefined') EmailApp.markAnalysisRead(this._openId, true);
        }
        this._wire();
        NavResizer.attach({
            layoutSel: '#fyi-view .fyi-layout',
            resizerId: 'fyi-nav-resizer',
            cssVar: '--actions-nav-width',
            storageKey: 'fyi-nav-width',
            defaultW: 188,
        });
        // The list divider. Wider range than a nav: how much of the row a
        // summary gets is a real preference, and a booking's second line
        // (route, span, code) wants more of it than a one-line receipt.
        NavResizer.attach({
            layoutSel: '#fyi-view .fyi-layout',
            resizerId: 'fyi-list-resizer',
            cssVar: '--fyi-list-width',
            storageKey: 'fyi-list-width',
            defaultW: 340,
            min: 240,
            max: 620,
        });
    },

    // Per-window UI state — sessionStorage, so Cmd+R restores what the user
    // was looking at without syncing the choice across Macs.
    _viewStateKey: 'anjadhe.fyi.viewState',

    _restoreViewState() {
        try {
            const s = JSON.parse(window.sessionStorage.getItem(this._viewStateKey) || '{}');
            if (typeof s.type === 'string') this._type = s.type;
            this._unreadOnly = !!s.unreadOnly;
            if (typeof s.openId === 'string') this._openId = s.openId;
            if (typeof s.account === 'string' && s.account) this._account = s.account;
        } catch (_) {}
    },

    _persistViewState() {
        try {
            window.sessionStorage.setItem(this._viewStateKey, JSON.stringify({
                type: this._type,
                unreadOnly: this._unreadOnly,
                openId: this._openId,
                account: this._account,
            }));
        } catch (_) {}
    },

    // ── Data ─────────────────────────────────────────────────────────────

    /**
     * Are there connected accounts at all? Read straight from the blob:
     * EmailApp.accounts is empty both when nothing is connected AND when it
     * simply has not loaded yet, so it cannot answer this on its own. Same
     * reasoning as js/apps/email/email-widget.js.
     */
    _accountsExist() {
        const data = StorageManager.get('email');
        return Array.isArray(data?.accounts) && data.accounts.length > 0;
    },

    /**
     * Is the mail actually in memory? NOT `EmailApp.accounts.length` —
     * AccountsManager.init pushes connected accounts into that array at
     * startup as a derived view, so it is non-empty on a session where
     * loadData never ran. Testing it left this page permanently empty
     * ("nothing that isn't already a task") until the Email app was opened,
     * because a page that believes it is loaded never kicks a load.
     */
    _loaded() {
        return typeof EmailApp !== 'undefined' && EmailApp._dataLoaded === true;
    },

    /**
     * Load mail in the background and repaint. Deliberately does NOT start
     * syncing or drain the analysis queue — that is the Email widget's job
     * (it is the app's email bootstrap) and doing it twice would double the
     * work on a session that opens both.
     */
    async _kickLoad() {
        if (this._loading || this._attempts >= this.MAX_ATTEMPTS) return;
        this._loading = true;
        this._attempts++;
        try {
            if (EmailApp._initInFlight) await EmailApp._initInFlight;
            else if (!EmailApp.emails.length) await EmailApp.loadData();
        } catch (e) {
            console.warn('[fyi] background email load failed:', e);
        } finally {
            this._loading = false;
            if (AppManager.currentApp === 'fyi') this.render();
        }
    },

    /**
     * The page's rows: EVERY insight still inside the window.
     *
     * Membership was "an insight that did not become a task" until
     * 2026-08-03. That rule made the page a remainder — you could read an
     * insight here, and then the moment it earned a task it vanished from
     * the one place that held the whole picture, leaving the mail behind a
     * task's source-email card. Being actionable is not a reason to be
     * unfindable. Insights live here; action items ALSO live in Tasks, and
     * the two are different questions ("what did my mail say?" vs "what do
     * I have to do?"), not one list split in two.
     *
     * The action rows on the detail carry the link across
     * (EmailUI.insightActionRows → taskIdForAction), so a tasked insight
     * now renders with a live door to its task instead of dead text — which
     * is what that machinery was built for and, under the old rule, almost
     * never got to do.
     *
     * Rolled-up matter members are still excluded: only the matter head
     * carries today's truth, same as the Email app's own list.
     */
    _items() {
        if (!this._loaded()) return [];
        const analyses = EmailApp.getProfileAnalyses();
        const cutoff = Date.now() - this.RETENTION_DAYS * 86400000;

        const rows = [];
        for (const [id, a] of Object.entries(analyses)) {
            if (!a || a.rolledUp) continue;
            const email = EmailApp.emailById(id);
            if (!email) continue;
            const ts = EmailApp._emailTime(email);
            if (ts < cutoff) continue;
            rows.push({ id, a, email, ts });
        }
        rows.sort((x, y) => y.ts - x.ts);
        return rows;
    },

    /** The canonical folder order: INSIGHT_TYPES with 'general' last. */
    _typeOrder() {
        return [...(EmailApp.INSIGHT_TYPES || []), 'general'];
    },

    /** type key -> rows, in INSIGHT_TYPES order with 'general' last. */
    _byType(rows) {
        const order = this._typeOrder();
        const map = new Map();
        for (const key of order) map.set(key, []);
        for (const r of rows) {
            const key = map.has(r.a.type) ? r.a.type : 'general';
            map.get(key).push(r);
        }
        // L5 — a type with nothing in it is not a heading with an empty
        // state under it, it is absent.
        for (const [key, list] of [...map]) if (!list.length) map.delete(key);
        return map;
    },

    _label(type) {
        return (EmailApp.INSIGHT_TYPE_LABELS || {})[type] || 'Other';
    },

    _shortDate(d) {
        const opts = { month: 'short', day: 'numeric' };
        if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
        return d.toLocaleDateString([], opts);
    },

    /**
     * What goes in the row's date gutter, and which KIND of date it is.
     *
     * The insight's own date ("in 3 days") when it has one — same
     * EmailApp._matterDate the home widget reads, so the two surfaces can
     * never disagree about which date an insight is about.
     *
     * Plenty of FYI mail has no date at all, though ("StreamNest charged
     * $15.99"), and a blank 84px gutter reads as a rendering fault, not a
     * choice — the Tasks list learned this and says "anytime". Here the
     * honest fallback is when the mail arrived, marked `arrival` so it can
     * be styled as a different kind of date. Rendering a received date in
     * the same voice as an event date would quietly lie.
     */
    _when(row) {
        // A booking's own extracted start beats the triage pass's single
        // eventDate — it is the field the reservation extractor exists to get
        // right, and it carries a time where eventDate never does.
        const iso = row.a.reservation?.start?.slice(0, 10) || EmailApp._matterDate?.(row.a);
        if (iso) {
            const today = new Date(); today.setHours(0, 0, 0, 0);
            const then = new Date(iso + 'T00:00:00');
            if (!isNaN(then)) {
                const days = Math.round((then - today) / 86400000);
                let label;
                if (days === 0) label = 'today';
                else if (days === 1) label = 'tomorrow';
                else if (days === -1) label = 'yesterday';
                else if (days < 0) label = `${Math.abs(days)} days ago`;
                else if (days <= 14) label = `in ${days} days`;
                else label = this._shortDate(then);
                return { label, arrival: false, title: '' };
            }
        }
        if (!row.ts) return { label: '', arrival: false, title: '' };
        const at = new Date(row.ts);
        return { label: this._shortDate(at), arrival: true, title: `Received ${at.toLocaleString()}` };
    },

    /**
     * The structured second line under a booking's summary: what the
     * reservation extractor found that the prose does not reliably say.
     *
     * Every part is optional and the line is skipped entirely when nothing
     * survived validation — a booking whose extraction failed reads exactly
     * like any other insight rather than showing a row of blanks.
     */
    _resTime(iso) {
        if (!iso || !iso.includes('T')) return '';
        const [h, m] = iso.slice(11, 16).split(':').map(Number);
        const ampm = h < 12 ? 'AM' : 'PM';
        return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${ampm}`;
    },

    /** "Mar 3" in a row, "Mon, Mar 3" where there is room to spell it out. */
    _resDay(iso, long = false) {
        if (!iso) return '';
        const [y, mo, d] = iso.slice(0, 10).split('-').map(Number);
        const dt = new Date(y, mo - 1, d);
        const opts = { month: 'short', day: 'numeric' };
        if (long) opts.weekday = 'short';
        if (dt.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
        return dt.toLocaleDateString([], opts);
    },

    /** "Mon, Mar 3, 6:00 PM to 9:00 PM" — one moment, one day, or a span. */
    _span(start, end) {
        if (!start) return '';
        const st = this._resTime(start), en = this._resTime(end);
        const sameDay = end && end.slice(0, 10) === start.slice(0, 10);
        if (!end) return this._resDay(start, true) + (st ? `, ${st}` : '');
        if (sameDay) return `${this._resDay(start, true)}${st ? `, ${st}` : ''}${en ? ` to ${en}` : ''}`;
        return `${this._resDay(start, true)}${st ? `, ${st}` : ''} to ${this._resDay(end, true)}${en ? `, ${en}` : ''}`;
    },

    _reservationLine(r) {
        if (!r) return '';
        const time = (iso) => this._resTime(iso);
        const day = (iso) => this._resDay(iso);

        const parts = [];
        if (r.from && r.to) parts.push(`${r.from} → ${r.to}`);

        // The span is the whole point for lodging (a check-out date is the
        // fact nobody else in the app holds) and reduces to a single moment
        // for a dinner reservation.
        if (r.start) {
            const sameDay = r.end && r.end.slice(0, 10) === r.start.slice(0, 10);
            const st = time(r.start), en = time(r.end);
            if (!r.end) parts.push(day(r.start) + (st ? `, ${st}` : ''));
            else if (sameDay) parts.push(`${day(r.start)}${st ? `, ${st}` : ''}${en ? ` → ${en}` : ''}`);
            else parts.push(`${day(r.start)}${st ? `, ${st}` : ''} → ${day(r.end)}${en ? `, ${en}` : ''}`);
        }

        if (r.confirmationCode) parts.push(r.confirmationCode);
        // Only worth saying while it is still true.
        if (r.cancelBy && r.cancelBy >= new Date().toISOString().slice(0, 10)) {
            parts.push(`free cancellation until ${day(r.cancelBy)}`);
        }
        return parts.join(' · ');
    },

    // ── Reading pane preference ──────────────────────────────────────────
    //
    // The Inbox's control, carried over (asked for 2026-08-04): the pane is
    // docked by default; turning it off gives the rows the full width, and
    // opening an insight then swaps to a full-width detail with a back
    // link. Per-machine localStorage like every other display preference —
    // pane layout depends on the monitor, so it must not ride the sync
    // journal. Below the 960px stack the preference is moot (the CSS is
    // scoped to min-width: 961px) and the toggle hides.

    _readerPref() {
        try { return localStorage.getItem('fyi-reader-pane') !== '0'; } catch { return true; }
    },

    toggleReader() {
        const turningOff = this._readerPref();
        try { localStorage.setItem('fyi-reader-pane', turningOff ? '0' : '1'); } catch { /* ignore */ }
        // Mirror the Inbox's guard: hiding the pane while an insight is open
        // would answer "no pane" with a full-width detail — drop back to the
        // list instead.
        if (turningOff && this._openId) this._openId = null;
        this.render();
    },

    _syncReaderToggle() {
        const btn = document.getElementById('fyi-reader-toggle');
        if (!btn) return;
        const on = this._readerPref();
        btn.setAttribute('aria-pressed', String(on));
        btn.classList.toggle('is-active', on);
        btn.title = on ? 'Hide reading pane' : 'Show reading pane';
    },

    // Unread-only on/off — the Inbox's header control, carried here so the
    // two mail surfaces filter the same way from the same place. The count
    // the old in-list toggle wore ("Unread (3)") is not lost: the nav's
    // folder counts are unread counts, always.
    toggleUnread() {
        this._unreadOnly = !this._unreadOnly;
        this.render();
        // render() syncs too, but returns early on gate/empty states — the
        // button must still answer the click there.
        this._syncUnreadToggle();
    },

    _syncUnreadToggle() {
        const btn = document.getElementById('fyi-filter-unread');
        if (!btn) return;
        const on = this._unreadOnly;
        btn.setAttribute('aria-pressed', String(on));
        btn.classList.toggle('is-active', on);
        const title = on ? 'Showing unread only' : 'Show unread only';
        btn.title = title;
        btn.setAttribute('aria-label', title);
    },

    // ── Render ───────────────────────────────────────────────────────────

    render() {
        Breadcrumb.render('fyi-breadcrumb', [{ label: 'Email AI' }]);

        const layout = document.querySelector('#fyi-view .fyi-layout');
        const nav = document.getElementById('fyi-nav');
        const list = document.getElementById('fyi-list');
        const main = document.getElementById('fyi-main');
        if (!nav || !list || !main) return;

        // Nothing to show: one message across the whole width. A nav and a
        // list column with nothing in them, dividers and all, reads as a
        // rendering fault rather than as "there is nothing here yet".
        // Deliberately does NOT clear _openId. This runs while mail is still
        // loading, and wiping the selection there threw away what a Cmd+R
        // was supposed to restore. A selection that no longer exists is
        // dropped below, where there is data to check it against.
        const empty = (message) => {
            layout?.classList.add('is-empty');
            layout?.classList.remove('is-overview', 'reader-off', 'is-reading');
            nav.innerHTML = '';
            list.innerHTML = '';
            main.innerHTML = `<div class="fyi-empty">${message}</div>`;
        };

        const gate = this._gateMessage();
        if (gate) { empty(gate); return; }

        const rows = this._items();
        // Account scope, applied before grouping so the type nav's counts say
        // what is true INSIDE the scope — same as scoping the Inbox.
        const scoped = this._account
            ? rows.filter(r => (r.email.account || '') === this._account)
            : rows;
        const groups = this._byType(scoped);

        if (!groups.size) {
            if (this._account) {
                // A scope with nothing in it must leave the way out on
                // screen — the full-width empty state would wipe the nav and
                // with it the switcher that undoes the scope.
                layout?.classList.remove('is-empty', 'is-reading');
                layout?.classList.add('is-overview');
                this._openId = null;
                this._persistViewState();
                this._renderNav(nav, groups, rows);
                list.innerHTML = '';
                main.innerHTML = `<div class="fyi-empty">Nothing from ${UIUtils.escapeHtml(this._account)} in the last ${this.RETENTION_DAYS} days.</div>`;
                return;
            }
            empty(`Nothing found in the last ${this.RETENTION_DAYS} days of mail. Bills, receipts, renewals, bookings and deliveries land here as your AI reads new email; anything that needs doing also shows up under Tasks.`);
            return;
        }
        layout?.classList.remove('is-empty');

        // No selected type = the OVERVIEW, the page's home: every folder at
        // once, each with its newest few rows. A selected folder stays
        // selected even when the scope has nothing for it — the nav lists
        // every folder now (see _renderNav), so an empty folder is a page
        // that says "Nothing here", not a selection to be bounced off. Only
        // a type the taxonomy no longer knows (a legacy name from an old
        // session) falls back to the overview.
        if (this._type && !this._typeOrder().includes(this._type)) this._type = null;

        // An open insight can go away under us — the mail ages past the
        // window, its action item finally became a task, or the account
        // scope excludes it. Fall back to the list rather than to an error.
        const open = this._openId ? scoped.find(r => r.id === this._openId) : null;
        if (this._openId && !open) this._openId = null;
        // The nav must point at the group the open insight belongs to — on a
        // restored session (or a type reassigned by re-analysis) the stored
        // selection and the open row can disagree. This also means an open
        // insight always renders in its folder, never over the overview.
        if (open) {
            for (const [key, rowsOfType] of groups) if (rowsOfType.includes(open)) { this._type = key; break; }
        }
        this._persistViewState();

        // The overview takes the list pane's width too — sections carry
        // their own rows, so a second list beside them would say everything
        // twice.
        layout?.classList.toggle('is-overview', !this._type);
        // Reading-pane preference: `reader-off` widens the list, `is-reading`
        // swaps to the full-width detail. Both are inert under 960px (the
        // stacked layout owns that range) and on the overview.
        layout?.classList.toggle('reader-off', !this._readerPref());
        layout?.classList.toggle('is-reading', !!open && !this._readerPref());
        this._syncReaderToggle();
        this._syncUnreadToggle();

        this._renderNav(nav, groups, rows);
        if (!this._type) {
            list.innerHTML = '';
            this._renderOverview(main, groups);
            return;
        }
        this._renderList(list, groups.get(this._type) || []);
        if (open) this._renderDetail(main, open);
        else this._renderPlaceholder(main, groups.get(this._type) || []);
    },

    /**
     * The page's home is a BRIEFING, not an index (2026-08-04 — the
     * every-folder-with-its-rows overview was reported as overwhelming: up
     * to ten sections over newspaper columns is a wall, and it repeated
     * what the nav already says). Two short groups answer the two
     * questions worth answering before any folder is opened:
     *
     *   Coming up — insights whose OWN date (reservation start, due date,
     *   event date; the same EmailApp._matterDate the home widget reads)
     *   is today or later, soonest first. This is the only group ordered
     *   by the event's clock rather than the mail's.
     *
     *   New since you last looked — unread, newest first, capped with an
     *   expand-in-place. Rows already in Coming up are not repeated.
     *
     * Everything read and undated lives in the folders — that is what the
     * always-complete nav is for. Same laws as the rest of the page:
     * nothing is generated to render it (L1), a group with nothing in it
     * is absent (L5), and unread is a mark, not a filter (L2).
     */
    OVERVIEW_NEW_CAP: 6,
    _ovExpandNew: false,

    _renderOverview(main, groups) {
        const esc = UIUtils.escapeHtml;
        // Flattened rows carrying their folder key — the tag on each row is
        // the door's name, so the reader knows where the row lives.
        const flat = [];
        for (const [type, list] of groups) for (const r of list) flat.push({ r, type });

        const now = new Date();
        const todayIso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
        const eventIso = (r) => r.a.reservation?.start?.slice(0, 10) || EmailApp._matterDate?.(r.a) || null;

        // The Unread/All toggle applies here as everywhere: under Unread,
        // Coming up drops its read rows. The second group is unread by
        // definition, so the toggle cannot change it.
        const upcoming = flat
            .filter(x => { const iso = eventIso(x.r); return iso && iso >= todayIso; })
            .filter(x => !this._unreadOnly || !x.r.a.readAt)
            .sort((a, b) => eventIso(a.r).localeCompare(eventIso(b.r)) || b.r.ts - a.r.ts);
        const upIds = new Set(upcoming.map(x => x.r.id));
        const fresh = flat
            .filter(x => !x.r.a.readAt && !upIds.has(x.r.id))
            .sort((a, b) => b.r.ts - a.r.ts);

        const rowHtml = (x) => {
            const when = this._when(x.r);
            const amount = (x.r.a.amount && x.r.a.amount !== 'null') ? String(x.r.a.amount) : '';
            const text = UIUtils.humanizeIsoDates(x.r.a.summary || x.r.email.subject || '(no subject)');
            const from = EmailApp._extractSenderName(x.r.email.from) || '';
            return `
                <button type="button" class="fyi-ov-row${x.r.a.readAt ? '' : ' is-unread'}" data-fyi-goto="${esc(x.r.id)}" data-fyi-goto-type="${esc(x.type)}">
                    <span class="fyi-row-when${when.arrival ? ' is-arrival' : ''}"${when.title ? ` title="${esc(when.title)}"` : ''}>${esc(when.label)}</span>
                    <span class="fyi-ov-text">${esc(text)}</span>
                    ${amount ? `<span class="fyi-row-meta">${esc(amount)}</span>` : ''}
                    ${from ? `<span class="fyi-ov-from"${x.r.email.from ? ` title="${esc(x.r.email.from)}"` : ''}>${esc(from)}</span>` : ''}
                    <span class="fyi-ov-tag">${esc(this._label(x.type))}</span>
                    ${x.r.a.readAt ? '' : '<span class="fyi-row-dot" aria-label="Unread"></span>'}
                </button>`;
        };

        let html = `<div class="fyi-overview">`;

        if (upcoming.length) {
            html += `
            <section class="fyi-ov-section">
                <h3 class="fyi-ov-eyebrow">Coming up</h3>
                ${upcoming.map(rowHtml).join('')}
            </section>`;
        }
        if (fresh.length) {
            const shown = this._ovExpandNew ? fresh : fresh.slice(0, this.OVERVIEW_NEW_CAP);
            html += `
            <section class="fyi-ov-section">
                <h3 class="fyi-ov-eyebrow">New since you last looked <span class="fyi-ov-count">${fresh.length}</span></h3>
                ${shown.map(rowHtml).join('')}
                ${fresh.length > shown.length ? `<button type="button" class="fyi-ov-more" data-fyi-ov-expand>All ${fresh.length} &#8594;</button>` : ''}
            </section>`;
        }
        if (!upcoming.length && !fresh.length) {
            html += `<div class="fyi-empty">All caught up — nothing coming up and nothing unread. The folders on the left hold everything from the last ${this.RETENTION_DAYS} days.</div>`;
        }
        html += '</div>';
        main.innerHTML = html;
    },

    /**
     * The reading pane with nothing selected. It says what to do rather than
     * sitting blank, and stays quiet about it — this is the state the page is
     * in every time it opens.
     */
    _renderPlaceholder(main, list) {
        const unread = list.filter(r => !r.a.readAt).length;
        main.innerHTML = `<div class="fyi-placeholder">
            <p>Pick something on the left to read it here.</p>
            ${unread ? `<p class="fyi-placeholder-note">${unread} unread in ${UIUtils.escapeHtml(this._label(this._type))}.</p>` : ''}
        </div>`;
    },

    /** Null when the page can show rows; an explanation when it cannot. */
    _gateMessage() {
        if (typeof EmailApp === 'undefined') return 'Email is unavailable.';
        if (!this._accountsExist()) {
            return 'Connect an email account and the assistant will pull out what matters: renewals, bills, deliveries, appointments. Anything that needs doing becomes a task; everything else lands here.';
        }
        if (!EmailApp.aiInsightsEnabled) {
            return 'AI email insights are turned off. Turn them on in Settings to see what the assistant finds in your mail.';
        }
        if (!this._loaded()) {
            this._kickLoad();
            return 'Loading your mail&hellip;';
        }
        return null;
    },

    /**
     * Folder counts are UNREAD counts, always — never the folder's size, and
     * not something that changes with the Unread/All toggle (it used to show
     * `list.length` under All, which is why "Bills 43" sat there for weeks
     * saying nothing).
     *
     * A number beside a folder name is read as "this much wants me", the
     * same as every mail sidebar. A total says only how much mail you have
     * received, which is not a fact anyone acts on, and it never moves — the
     * one thing a count is for is telling you it changed. A folder with
     * nothing unread shows NO count rather than a 0, so the nav goes quiet
     * as you work through it.
     *
     * The nav lists EVERY folder, always, in taxonomy order (2026-08-04).
     * It used to show only folders with rows in the current scope, so the
     * list reshuffled as mail aged and accounts were switched — navigation
     * that moves cannot be used by muscle memory (the same reasoning that
     * made ⌘K frequency-based). L5 ("a type with nothing in it is absent")
     * still governs CONTENT — the overview's sections and the folder counts
     * — but the nav is chrome: an empty folder renders in the quiet
     * `is-quiet` voice and opens to its own definition, which is also how
     * the taxonomy explains itself before mail has arrived to demonstrate
     * it.
     */
    _renderNav(nav, groups, allRows) {
        const unreadIn = (list) => list.filter(r => !r.a.readAt).length;
        let html = '<div class="actions-nav-header">Insights</div>';
        html += '<div class="actions-nav-section">';
        // The page's home. data-fyi-type="" resolves to null in the click
        // handler; its badge is the total across folders, same voice as the
        // per-folder counts.
        const total = [...groups.values()].reduce((n, list) => n + unreadIn(list), 0);
        html += `
            <button type="button" class="actions-nav-item${this._type ? '' : ' is-active'}"
                    data-fyi-type="">
                <span class="actions-nav-label">Overview</span>
                ${total ? `<span class="actions-nav-count">${total}</span>` : ''}
            </button>`;
        for (const type of this._typeOrder()) {
            const list = groups.get(type) || [];
            const shown = unreadIn(list);
            html += `
                <button type="button" class="actions-nav-item${type === this._type ? ' is-active' : ''}${list.length ? '' : ' is-quiet'}"
                        data-fyi-type="${UIUtils.escapeHtml(type)}">
                    <span class="actions-nav-label">${UIUtils.escapeHtml(this._label(type))}</span>
                    ${shown ? `<span class="actions-nav-count">${shown}</span>` : ''}
                </button>`;
        }
        html += '</div>';
        html += this._accountsNavHtml(allRows || []);
        nav.innerHTML = html;
    },

    /**
     * The Accounts section at the bottom of the nav — the Inbox sidebar's
     * pattern, carried over: one account is a read-only fact (all actions
     * live in Settings), several become a scope switcher. Badges follow this
     * page's own law (counts are UNREAD counts, always) — an account's badge
     * is its unread insights across every type, unscoped, so the switcher
     * says something even when never clicked.
     */
    _accountsNavHtml(rows) {
        const esc = UIUtils.escapeHtml;
        const accounts = (typeof EmailApp !== 'undefined' && EmailApp.getAccounts)
            ? EmailApp.getAccounts() : [];
        if (!accounts.length) return '';
        let html = '<div class="actions-nav-header">Accounts</div><div class="actions-nav-section">';
        if (accounts.length === 1) {
            html += `<div class="fyi-account-static" title="${esc(accounts[0].email)}">${esc(accounts[0].email)}</div>`;
        } else {
            const unreadFor = (acct) => rows.filter(r =>
                !r.a.readAt && (!acct || (r.email.account || '') === acct)).length;
            const rowHtml = (acct, label) => {
                const active = (this._account || '') === acct;
                const n = unreadFor(acct);
                return `
                <button type="button" class="actions-nav-item${active ? ' is-active' : ''}"
                        data-fyi-account="${esc(acct)}"${acct ? ` title="${esc(acct)}"` : ''}>
                    <span class="actions-nav-label">${esc(label)}</span>
                    ${n ? `<span class="actions-nav-count">${n}</span>` : ''}
                </button>`;
            };
            html += rowHtml('', 'All accounts') + accounts.map(a => rowHtml(a.email, a.email)).join('');
        }
        html += '</div>';
        html += '<button type="button" class="fyi-accounts-manage" data-fyi-manage-accounts>Manage accounts in Settings &rsaquo;</button>';
        return html;
    },

    _renderList(pane, list) {
        // The row you are READING is never filtered out from under you.
        //
        // Opening an insight marks it read, so under the Unread filter the
        // row vanished the instant it was clicked — you lost your place in
        // the list, and the page contradicted its own L2 ("unread is a mark,
        // not a filter"): it was a filter, and reading did consume. Same
        // rule every mail client uses — the open message stays in a filtered
        // list until you select something else, and then it drops out
        // because it is genuinely read and no longer where you are.
        const rows = this._unreadOnly
            ? list.filter(r => !r.a.readAt || r.id === this._openId)
            : list;
        // The nav's folder counts stay HONEST unread counts and deliberately
        // do not include that exemption — they tick down as you read even
        // while the row you just read is still on screen.

        // The folder says what is in it. A one-noun name (Bills, Receipts,
        // Deadlines) is only predictable if the boundary is stated once —
        // the labels alone left a library checkout looking like a receipt.
        const blurb = (EmailApp.INSIGHT_TYPE_BLURBS || {})[this._type] || '';
        let html = `
            <div class="fyi-head">
                <h3 class="fyi-title">${UIUtils.escapeHtml(this._label(this._type))}</h3>
            </div>
            ${blurb ? `<p class="fyi-blurb">${UIUtils.escapeHtml(blurb)}</p>` : ''}`;

        if (!rows.length) {
            html += `<div class="fyi-empty">${this._unreadOnly ? 'Nothing unread here.' : 'Nothing here.'}</div>`;
            pane.innerHTML = html;
            return;
        }

        html += '<div class="fyi-list">';
        for (const r of rows) {
            const when = this._when(r);
            const amount = (r.a.amount && r.a.amount !== 'null') ? String(r.a.amount) : '';
            const text = UIUtils.humanizeIsoDates(r.a.summary || r.email.subject || '(no subject)');
            const res = r.a.reservation;
            const detail = this._reservationLine(res);
            const cancelled = res?.status === 'cancelled';
            const changed = res?.status === 'changed';
            // Who it came from, under the summary. A summary says WHAT
            // happened and routinely omits the one thing that identifies it
            // — "Your statement is ready" is four different companies in one
            // folder. Display name when the header carries one, the bare
            // address when it doesn't; the full header goes in the tooltip,
            // so the row stays short without hiding anything.
            const from = EmailApp._extractSenderName(r.email.from) || '';
            html += `
                <button type="button" class="fyi-row${r.a.readAt ? '' : ' is-unread'}${cancelled ? ' is-cancelled' : ''}${r.id === this._openId ? ' is-selected' : ''}"
                        data-fyi-open="${UIUtils.escapeHtml(r.id)}"${r.id === this._openId ? ' aria-current="true"' : ''}>
                    <!-- The date twice, on purpose: the wide layout puts it in
                         the left gutter, the narrow one folds it onto the
                         metadata line beside the sender. Exactly one is ever
                         display:none — see the @container block in fyi.css,
                         which explains why this beats moving one span across
                         two nesting levels with flex ordering. -->
                    <span class="fyi-row-when${when.arrival ? ' is-arrival' : ''}"${when.title ? ` title="${UIUtils.escapeHtml(when.title)}"` : ''}>${UIUtils.escapeHtml(when.label)}</span>
                    <span class="fyi-row-body">
                        <span class="fyi-row-main">
                            <span class="fyi-row-text">${UIUtils.escapeHtml(text)}</span>
                            ${cancelled ? '<span class="fyi-row-flag">Cancelled</span>' : ''}
                            ${changed ? '<span class="fyi-row-flag">Changed</span>' : ''}
                            ${amount ? `<span class="fyi-row-meta">${UIUtils.escapeHtml(amount)}</span>` : ''}
                        </span>
                        <span class="fyi-row-sub">
                            ${from ? `<span class="fyi-row-from"${r.email.from ? ` title="${UIUtils.escapeHtml(r.email.from)}"` : ''}>${UIUtils.escapeHtml(from)}</span>` : ''}
                            ${detail ? `<span class="fyi-row-detail">${UIUtils.escapeHtml(detail)}</span>` : ''}
                            <span class="fyi-row-when-inline${when.arrival ? ' is-arrival' : ''}">${UIUtils.escapeHtml(when.label)}</span>
                        </span>
                    </span>
                    ${r.a.readAt ? '' : '<span class="fyi-row-dot" aria-label="Unread"></span>'}
                </button>`;
        }
        html += '</div>';
        pane.innerHTML = html;
    },

    // ── Detail ───────────────────────────────────────────────────────────

    /**
     * One insight, in this page, in this app. It used to hand off to the
     * Email app's insight detail; that answered "what did the assistant find"
     * by moving the user to a different app, losing the group they were
     * working through and putting a mail client between them and a fact.
     *
     * Same anatomy as the task and goal details next door: a title, then a
     * quiet property list with a label gutter — the extracted structure
     * (route, span, confirmation code, amount) laid out as properties rather
     * than crushed into the one comma line a row has space for. Nothing here
     * is generated to render the page (L1): every value is a stored field.
     *
     * It carries no back link: this is a reading pane, and the list it came
     * from is right there. Esc clears the selection.
     *
     * The email itself stays one click away — this page organizes what was
     * found; the message is still the source, and "Open email" goes to it.
     */
    _renderDetail(main, row) {
        const esc = UIUtils.escapeHtml;
        const { a, email } = row;
        const res = a.reservation;
        const isRead = !!a.readAt;
        const received = row.ts ? new Date(row.ts) : null;

        // Properties, in the order they answer questions: when, where, which
        // booking, how much, who from, when it arrived. Every row is skipped
        // when its field is missing — a booking whose extraction failed reads
        // as a plain insight instead of a column of blanks.
        const props = [];
        const push = (label, value, cls) => {
            if (value) props.push({ label, value, cls: cls || '' });
        };

        if (res?.start) {
            push('When', this._span(res.start, res.end));
            // A round trip is an outbound and a return, and the return leg is
            // a date the user holds that nothing else in the app carries.
            if (res.returnStart) push('Return', this._span(res.returnStart, res.returnEnd));
        } else {
            const iso = EmailApp._matterDate?.(a);
            if (iso) push('When', this._resDay(iso, true));
        }
        if (res?.from && res?.to) push('Route', `${res.from} to ${res.to}`);
        if (res?.place) push('Where', res.place);
        push('Booked with', res?.vendor);
        push('Confirmation', res?.confirmationCode);
        if (res?.cancelBy && res.cancelBy >= new Date().toISOString().slice(0, 10)) {
            push('Cancel by', `Free cancellation until ${this._resDay(res.cancelBy, true)}`);
        }
        if (a.amount && a.amount !== 'null') push('Amount', String(a.amount));
        push('From', EmailUI.extractName(email.from));
        if (received) push('Received', received.toLocaleString());

        const actions = a.actionItems || [];
        const flag = res?.status === 'cancelled' ? 'Cancelled' : res?.status === 'changed' ? 'Changed' : '';

        // With the reading pane off there is no list beside the detail to be
        // the way back (the "no back link" rule above assumes one), so a
        // back row names the folder. Esc already walks the same path.
        const back = this._readerPref() ? '' :
            `<button type="button" class="fyi-detail-back" data-fyi-back>&#8592; ${esc(this._label(this._type))}</button>`;

        let html = `
            <div class="fyi-detail">
                ${back}
                <article class="fyi-detail-page">
                    <div class="fyi-detail-chips">
                        ${EmailUI.insightTypeChip(a)}
                        ${flag ? `<span class="fyi-row-flag">${flag}</span>` : ''}
                        ${isRead ? '' : '<span class="fyi-detail-unread">Unread</span>'}
                    </div>
                    <h3 class="fyi-detail-title">${esc(UIUtils.humanizeIsoDates(email.subject) || '(no subject)')}</h3>
                    ${a.summary ? `<p class="fyi-detail-lede">${esc(UIUtils.humanizeIsoDates(a.summary))}</p>` : ''}
                    ${props.length ? `<div class="fyi-props">${props.map(p => `
                        <div class="fyi-prop">
                            <span class="fyi-prop-label">${esc(p.label)}</span>
                            <span class="fyi-prop-value">${esc(p.value)}</span>
                        </div>`).join('')}</div>` : ''}`;

        if (actions.length) {
            html += `
                    <div class="fyi-detail-section-label">Action items</div>
                    <div class="fyi-action-items">
                        ${EmailUI.insightActionRows(email, EmailApp, actions)}
                    </div>`;
        }

        html += `
                    ${EmailUI.insightMatterTimeline(row.id, EmailApp)}
                    ${EmailUI.insightActionsRow(email, EmailApp)}
                    <div class="fyi-detail-footer">
                        <button type="button" class="fyi-detail-btn" data-fyi-open-email="${esc(row.id)}">Open email &#8594;</button>
                        <div class="fyi-detail-footer-group">
                            <button type="button" class="fyi-detail-btn" data-fyi-read="${isRead ? 'unread' : 'read'}">${isRead ? 'Mark unread' : '&#10003; Mark read'}</button>
                            <button type="button" class="fyi-detail-btn is-danger" data-fyi-delete>Delete</button>
                        </div>
                    </div>
                </article>
            </div>`;

        main.innerHTML = html;
        this._wireDetail(main, row);
    },

    _wireDetail(main, row) {
        // The shared feedback row (Useful / Not useful / Follow / Mute / Add
        // task) repaints its surface after an action. It cannot know about
        // this page, so hand it our own repaint.
        main._insightRefresh = () => this.render();
        EmailUI.bindInsightActions(main, EmailApp);

        // origin 'fyi' — the editor's back crumb returns HERE, to the insight
        // the task came from, not to the Email app.
        EmailUI.bindInsightActionLinks(main, 'fyi');

        // Matter timeline: the earlier notices about the same thing. Their
        // summaries open the message; "Not this" splits one back out.
        main.querySelectorAll('.insight-matter-summary').forEach(el => {
            el.addEventListener('click', () => {
                this._openEmail(el.closest('[data-member-id]').dataset.memberId);
            });
        });
        main.querySelectorAll('.insight-matter-unfold').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (!EmailApp.unfoldFromMatter(row.id, btn.dataset.memberId)) return;
                UIUtils.showToast('Split out as its own insight', 'success');
                this.render();
            });
        });

        main.querySelector('[data-fyi-open-email]')?.addEventListener('click', (e) => {
            this._openEmail(e.currentTarget.dataset.fyiOpenEmail);
        });

        main.querySelector('[data-fyi-read]')?.addEventListener('click', (e) => {
            EmailApp.markAnalysisRead(row.id, e.currentTarget.dataset.fyiRead === 'read');
            this.render();
        });

        // Delete = "this shouldn't be here", scoped to this one email — the
        // per-message cousin of the feedback row's Not useful (which teaches
        // sender+type suppression) and Mute (which silences a sender). The
        // confirm names what does NOT go: the mail itself, and any task the
        // insight already created.
        main.querySelector('[data-fyi-delete]')?.addEventListener('click', async () => {
            const thread = row.a.matter?.members?.length;
            const ok = await UIUtils.confirm(
                'Delete Insight',
                `Delete this insight${thread ? ' and its earlier notices' : ''}? The email stays in your mailbox, and any task it created stays in Tasks.`,
                '',
                { confirmText: 'Delete' }
            );
            if (!ok) return;
            if (!EmailApp.deleteInsight(row.id)) return;
            this._openId = null;
            UIUtils.showToast('Insight deleted', 'success');
            this.render();
        });
    },

    /**
     * Anchored row menu (right-click) — same one-at-a-time popover contract
     * as TaskListUI.openMenu, and the same .task-menu classes so the two
     * menus cannot drift apart visually.
     */
    _rowMenu(id, at) {
        this._closeRowMenu();
        const read = !!(EmailApp.getProfileAnalyses() || {})[id]?.readAt;
        const items = [
            { label: read ? 'Mark unread' : 'Mark read', act: () => {
                EmailApp.markAnalysisRead(id, !read);
                this.render();
            } },
            { label: 'Open email', act: () => this._openEmail(id) },
        ];
        const menu = document.createElement('div');
        menu.className = 'task-menu';
        menu.innerHTML = items.map((it, i) =>
            `<button type="button" class="task-menu-item" data-idx="${i}">${it.label}</button>`
        ).join('');
        document.body.appendChild(menu);
        this._menu = menu;
        const mw = menu.offsetWidth, mh = menu.offsetHeight;
        menu.style.left = `${Math.max(8, Math.min(at.x, window.innerWidth - mw - 8))}px`;
        menu.style.top = `${Math.min(at.y, window.innerHeight - mh - 8)}px`;
        menu.addEventListener('click', (e) => {
            const btn = e.target.closest('.task-menu-item');
            if (!btn) return;
            e.stopPropagation();
            this._closeRowMenu();
            items[Number(btn.dataset.idx)].act();
        });
        this._menuDismiss = (e) => {
            if (e.type === 'keydown' && e.key !== 'Escape') return;
            if (e.type === 'mousedown' && e.target.closest('.task-menu')) return;
            // Esc closes the MENU only — without this it falls through to the
            // page's own Esc handler and collapses the reading pane too.
            if (e.type === 'keydown') e.stopImmediatePropagation();
            this._closeRowMenu();
        };
        document.addEventListener('mousedown', this._menuDismiss, true);
        document.addEventListener('keydown', this._menuDismiss, true);
    },

    _closeRowMenu() {
        if (this._menu && this._menu.parentNode) this._menu.parentNode.removeChild(this._menu);
        this._menu = null;
        if (this._menuDismiss) {
            document.removeEventListener('mousedown', this._menuDismiss, true);
            document.removeEventListener('keydown', this._menuDismiss, true);
            this._menuDismiss = null;
        }
    },

    /**
     * The message behind an insight, with the way back to this page. The
     * open insight is still in _openId, so returning lands on the same row
     * in the same group, not on a fresh page.
     */
    _openEmail(messageId) {
        EmailApp.openMessageFrom(messageId, {
            label: 'Email AI',
            onBack: () => AppManager.openApp('fyi'),
        });
    },

    /**
     * Open this page ON an insight, from outside it (the home widget). A
     * consume-once field rather than a call after openApp: init() restores
     * the saved selection, so anything assigned before it would be thrown
     * away — the same shape as EmailApp's own deep-link flags.
     */
    openTo(messageId) {
        this._pendingOpenId = messageId;
        AppManager.openApp('fyi');
    },

    openInsight(messageId) {
        this._openId = messageId;
        // Opening it reads it — like opening a message. Unread is a mark, not
        // a filter (L2): the row stays in its group, it just stops carrying
        // the dot, and the detail's own button puts the mark back. That holds
        // under the Unread toggle too — see the _openId exemption in
        // _renderList, which is what makes the claim above true rather than
        // merely intended.
        EmailApp.markAnalysisRead(messageId, true);
        this.render();
    },

    closeInsight() {
        if (!this._openId) return false;
        this._openId = null;
        this.render();
        return true;
    },

    // ── Events ───────────────────────────────────────────────────────────

    _wire() {
        const view = document.getElementById('fyi-view');
        if (!view || view._fyiWired) return;
        view._fyiWired = true;

        // Header door to the mail itself. A plain openApp is enough and is
        // the honest match for the label: EmailApp._initBody resets
        // currentView/currentLabel to the inbox on every open, so this
        // cannot land on whatever message the user was last reading.
        document.getElementById('fyi-reader-toggle')
            ?.addEventListener('click', () => this.toggleReader());
        document.getElementById('fyi-filter-unread')
            ?.addEventListener('click', () => this.toggleUnread());
        document.getElementById('fyi-inbox-btn')
            ?.addEventListener('click', () => AppManager.openApp('email'));

        view.addEventListener('click', (e) => {
            // Overview rows: land IN the folder, ON the insight — the
            // overview is a door, and doors go somewhere specific.
            const ovRow = e.target.closest('[data-fyi-goto]');
            if (ovRow) {
                this._type = ovRow.dataset.fyiGotoType;
                this.openInsight(ovRow.dataset.fyiGoto);
                return;
            }

            const typeBtn = e.target.closest('[data-fyi-type]');
            if (typeBtn) {
                // Clicking any type closes an open insight back to that
                // type's list — same rule the Tasks tab's nav follows.
                // "" (the Overview entry) resolves to null.
                this._openId = null;
                this._type = typeBtn.dataset.fyiType || null;
                this.render();
                return;
            }

            // Back out of the full-width detail (reading pane off).
            if (e.target.closest('[data-fyi-back]')) {
                this.closeInsight();
                return;
            }

            // Unfold the rest of the overview's "New" group in place.
            if (e.target.closest('[data-fyi-ov-expand]')) {
                this._ovExpandNew = true;
                this.render();
                return;
            }

            const acctBtn = e.target.closest('[data-fyi-account]');
            if (acctBtn) {
                const acct = acctBtn.dataset.fyiAccount || null;
                // Clicking the already-active account returns to All — same
                // gesture as the Inbox switcher.
                this._account = acct === this._account ? null : acct;
                this._openId = null;
                this.render();
                return;
            }

            if (e.target.closest('[data-fyi-manage-accounts]')) {
                AppManager.openApp('settings');
                setTimeout(() => SettingsApp.openCategory('accounts'), 50);
                return;
            }

            const row = e.target.closest('[data-fyi-open]');
            if (row) this.openInsight(row.dataset.fyiOpen);
        });

        // Right-click on a row: mark read/unread without opening it. Opening
        // an insight reads it (L2), so before this the only way to keep a row
        // unread was to never look at it — the detail footer's "Mark unread"
        // requires the very open that consumed the mark.
        view.addEventListener('contextmenu', (e) => {
            const row = e.target.closest('[data-fyi-open], [data-fyi-goto]');
            if (!row) return;
            e.preventDefault();
            this._rowMenu(row.dataset.fyiOpen || row.dataset.fyiGoto, { x: e.clientX, y: e.clientY });
        });

        // Escape walks back out: detail → folder → overview. Same shape as
        // the Tasks tab's inline task, with the page's home as the floor.
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape' || AppManager.currentApp !== 'fyi') return;
            if (e.target.closest?.('input, textarea, [contenteditable="true"]')) return;
            if (this._openId) { this.closeInsight(); return; }
            if (this._type) { this._type = null; this.render(); }
        });
    },
};

AppManager.register('fyi', FyiPage);
