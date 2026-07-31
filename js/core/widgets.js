/**
 * Widgets — home's attention surface.
 *
 * Home is the assistant's page: composer first, then what the apps are
 * holding for you. Widgets are how an app speaks on home WITHOUT becoming
 * an icon the user has to remember to visit.
 *
 * The rule that makes this work: **a widget with nothing to say does not
 * render.** Not "0 unread", not a grey empty state — absent. Home empties
 * itself as the user handles things, and on a calm day this whole region
 * is gone. That is the opposite of a launcher grid, and it is the reason
 * the app list can leave the nav.
 *
 * Two kinds, and the distinction is "does the user come looking for this?":
 *
 *   attention (the default) — renders only when non-empty, vanishes when
 *       handled. Overdue tasks, unread email insights, today's events.
 *       Nobody opens an app to check their unread count.
 *
 *   glance — always renders while the app has data, shows state rather
 *       than a queue. Portfolio: people genuinely open the app to look at
 *       the number. Declared explicitly (`kind: 'glance'`) so adding one
 *       is a visible decision in a diff, never drift.
 *
 * Glance widgets ALWAYS sort below attention widgets regardless of
 * `order` — a net-worth figure can never push an overdue bill down the
 * page. That ordering guarantee is what keeps the exception safe.
 *
 * Contract for `load()`:
 *   return null            → the card is not rendered at all
 *   return { body, … }     → the card renders with `body` as its innards
 *
 * Registration lives with the app it speaks for (js/apps/<app>/*-widget.js),
 * because a widget is that app's public face on home.
 *
 * CSP note: index.html forbids inline script, so no handler may be written
 * into markup. Widgets declare actions with `data-w-action` attributes and
 * implement `onAction`; this module delegates from the host.
 */
const Widgets = {
    KINDS: ['attention', 'glance'],

    _defs: [],
    _host: null,
    _wired: false,
    // Guards against an older slow load() painting over a newer render.
    _renderToken: 0,
    _refreshTimer: null,

    /**
     * @param {string} id      stable id, also the data-widget attribute
     * @param {object} def
     *   kind    'attention' (default) | 'glance'
     *   title   card heading
     *   app     AppManager id the header's open control navigates to
     *   order   within the kind; lower is higher on the page. Urgency
     *           class, not app identity: 10 blocking / 20 needs a
     *           decision / 30 time-sensitive today.
     *   load()  → null | { body, count, footer }   (may be async)
     *   onAction(action, data, el)   optional, for data-w-action buttons
     */
    register(id, def) {
        if (!id || typeof def?.load !== 'function') {
            console.warn('[widgets] register needs an id and a load()', id);
            return;
        }
        const kind = def.kind || 'attention';
        if (!this.KINDS.includes(kind)) {
            console.warn(`[widgets] unknown kind "${kind}" for ${id}`);
            return;
        }
        const existing = this._defs.findIndex(d => d.id === id);
        const entry = { ...def, id, kind, order: Number.isFinite(def.order) ? def.order : 50 };
        if (existing >= 0) this._defs[existing] = entry;
        else this._defs.push(entry);
    },

    /** Registration order breaks ties so the layout is stable run to run. */
    _sorted() {
        return this._defs
            .map((d, i) => ({ d, i }))
            .sort((a, b) => {
                const kindRank = (x) => (x.d.kind === 'glance' ? 1 : 0);
                return kindRank(a) - kindRank(b)
                    || a.d.order - b.d.order
                    || a.i - b.i;
            })
            .map(x => x.d);
    },

    async render(host) {
        host = host || this._host || document.getElementById('dash-widgets');
        if (!host) return;
        this._host = host;
        this._wire(host);

        const token = ++this._renderToken;
        const defs = this._sorted();

        // One slow or throwing widget must not take the region down with it.
        const results = await Promise.all(defs.map(def =>
            Promise.resolve()
                .then(() => def.load())
                .catch(err => {
                    console.warn(`[widgets] ${def.id} load failed:`, err);
                    return null;
                })
        ));
        if (token !== this._renderToken) return;   // a newer render won

        const live = [];
        results.forEach((res, i) => {
            if (res && res.body) live.push({ def: defs[i], res });
        });

        if (!live.length) {
            host.innerHTML = '';
            host.hidden = true;
            return;
        }
        host.hidden = false;
        host.innerHTML = this._columns(live);
    },

    /**
     * Two columns, filled greedily by estimated height.
     *
     * Walk the cards in priority order and drop each into whichever column
     * is currently shorter. That puts the two most urgent things side by
     * side at the top and keeps the columns from ending ragged — which is
     * what `column-count` gives you, since it balances by splitting the
     * list in half regardless of how tall each card is.
     *
     * The glance rule survives in spirit rather than to the letter: a glance
     * card is placed last, so it can never push an attention card DOWN, but
     * in two columns it can sit beside one. Below 1100px the CSS collapses
     * this to a single column and strict priority order returns.
     */
    _columns(live) {
        const cols = [[], []];
        const h = [0, 0];
        live.forEach((item, priority) => {
            const i = h[0] <= h[1] ? 0 : 1;
            // Carry the priority index onto the card. Column DOM order is
            // col-1-then-col-2, so when the CSS collapses to one column the
            // cards would otherwise read Overdue, Today, Coming up — the
            // left column's tail before the right column's head. `order`
            // restores true priority there (the column divs go
            // display:contents under 1100px). Within a column it is inert,
            // since these indices are already ascending.
            cols[i].push({ ...item, priority });
            h[i] += this._estimateHeight(item);
        });
        return cols.map(col =>
            `<div class="dash-widgets-col">${col.map(({ def, res, priority }) => this._card(def, res, priority)).join('')}</div>`
        ).join('');
    },

    /** Rough row-count arithmetic — good enough to balance, and free. */
    _estimateHeight(item) {
        const HEAD = 42, ROW = 30, FOOT = 24;
        const rows = (item.res.body.match(/class="widget-row"/g) || []).length;
        // A glance card's body is bespoke markup, not rows; measure it by
        // its own line breaks instead of pretending it has none.
        const blocks = rows || (item.res.body.match(/<div /g) || []).length;
        return HEAD + blocks * ROW + (item.res.footer ? FOOT : 0);
    },

    /** Repaint after an inline action or a data change. Debounced. */
    refresh() {
        clearTimeout(this._refreshTimer);
        this._refreshTimer = setTimeout(() => {
            if (!document.getElementById('dashboard-view')?.classList.contains('active')) return;
            this.render();
        }, 80);
    },

    /**
     * Card chrome, minus three accessories the first version wore: the inner
     * divider under the header, the bordered pill around the count, and the
     * always-visible chevron button. Four pieces of furniture to deliver two
     * lines of text is what made these read as generic dashboard widgets.
     *
     * The whole header is now the click target into the app, so the chevron
     * only appears on hover — the affordance is there when you reach for it
     * and absent when you are reading.
     */
    _card(def, res, order = 0) {
        const esc = UIUtils.escapeHtml.bind(UIUtils);
        const count = (res.count !== undefined && res.count !== null)
            ? `<span class="widget-count">${esc(String(res.count))}</span>` : '';
        const head = def.app
            ? `<button class="widget-head" type="button" data-w-open
                       aria-label="Open ${esc(def.title)}">
                 <h3 class="widget-title">${esc(def.title)}</h3>
                 ${count}
                 <svg class="widget-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                      stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"
                      aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>
               </button>`
            : `<div class="widget-head"><h3 class="widget-title">${esc(def.title)}</h3>${count}</div>`;
        return `
        <section class="widget-card" data-widget="${esc(def.id)}" data-kind="${esc(def.kind)}" style="order:${order}">
            ${head}
            <div class="widget-body">${res.body}</div>
            ${res.footer ? `<footer class="widget-foot">${res.footer}</footer>` : ''}
        </section>`;
    },

    // ── Markup helpers, so every attention widget reads identically ──

    /**
     * Standard row list.
     * item: { text, sub?, flag?, actions?: [{ label, action, id, title? }] }
     *
     * `sub` — the "when" — sits in a fixed-width LEFT gutter rather than
     * trailing the title. Nearly everything on this page is time-anchored
     * (3 days ago / in 25 min / 2:00 PM), so a shared column lets the eye
     * scan the day down one edge instead of hunting for grey text at the
     * end of each line. Rows with no time simply leave the gutter empty,
     * which reads as "no particular hour" rather than as a gap.
     *
     * `flag` stays inline after the title: it is a status, not a time, and
     * putting it in the time column would make the column mean two things.
     */
    rows(items) {
        const esc = UIUtils.escapeHtml.bind(UIUtils);
        return `<ul class="widget-rows">` + items.map(it => {
            const acts = (it.actions || []).map(a =>
                `<button class="widget-row-btn" type="button"
                         data-w-action="${esc(a.action)}" data-w-id="${esc(String(a.id ?? ''))}"
                         title="${esc(a.title || a.label)}">${esc(a.label)}</button>`
            ).join('');
            return `<li class="widget-row">
                <span class="widget-row-when">${it.sub ? esc(it.sub) : ''}</span>
                <span class="widget-row-text">${esc(it.text)}</span>
                ${it.flag ? `<span class="widget-row-flag">${esc(it.flag)}</span>` : ''}
                ${acts ? `<span class="widget-row-actions">${acts}</span>` : ''}
            </li>`;
        }).join('') + `</ul>`;
    },

    /**
     * Overflow line. Widgets cap their rows and hand the rest to the app —
     * home never scrolls because one widget had a lot to say.
     */
    more(n, label = 'more') {
        if (!n || n < 1) return '';
        return `<button class="widget-more" type="button" data-w-open>+${n} ${UIUtils.escapeHtml(label)}</button>`;
    },

    _wire(host) {
        if (this._wired) return;
        this._wired = true;

        host.addEventListener('click', (e) => {
            const card = e.target.closest('.widget-card[data-widget]');
            if (!card) return;
            const def = this._defs.find(d => d.id === card.dataset.widget);
            if (!def) return;

            if (e.target.closest('[data-w-open]')) {
                if (def.app) AppManager.openApp(def.app);
                return;
            }
            const btn = e.target.closest('[data-w-action]');
            if (!btn || !def.onAction) return;
            try {
                def.onAction(btn.dataset.wAction, { id: btn.dataset.wId }, btn);
            } catch (err) {
                console.warn(`[widgets] ${def.id} action failed:`, err);
            }
        });

        // Apps announce writes (see ScheduleApp.saveData); home repaints so
        // an Undo toast or a background sync is reflected without a revisit.
        document.addEventListener('anjadhe:data-changed', () => this.refresh());
    }
};
