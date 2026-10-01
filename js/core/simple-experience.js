/** Alternate shell only. Never changes stored data, model routing or consent. */
const SimpleExperience = {
    enabled: false,

    /**
     * The default shell since 2026-09-20 — a PREFERENCE, not a feature flag.
     * It graduated out of FEATURE_DEFAULTS because an override there can
     * enable but never disable, and a default experience has to be one you
     * can leave: absent means on, and only an explicit 'off' turns it back
     * into the full shell. Per-Mac like the theme and the side-nav collapse
     * (this is presentation, and the Macs sharing a journal may differ);
     * read once at startup, because init() builds the shell and has no
     * teardown, which is why the Settings switch reloads.
     */
    PREF_KEY: 'simple-experience',

    isOn() {
        try { return localStorage.getItem(this.PREF_KEY) !== 'off'; }
        catch { return true; }
    },

    setOn(on) {
        try {
            if (on) localStorage.removeItem(this.PREF_KEY);
            else localStorage.setItem(this.PREF_KEY, 'off');
        } catch { /* localStorage unavailable — nothing to persist */ }
    },

    init() {
        if (this.enabled || !this.isOn()) return;
        this.enabled = true;
        document.body.classList.add('simple-experience');

        const actions = document.querySelector('.titlebar-actions');
        const nav = document.createElement('nav');
        nav.className = 'simple-nav';
        nav.setAttribute('aria-label', 'Main navigation');
        nav.innerHTML = '<button type="button" data-simple="history">Chat History</button><button type="button" data-simple="settings">Settings</button>';
        if (FEATURES.isEnabled('workrooms')) nav.insertAdjacentHTML('afterbegin', '<button type="button" data-simple="workrooms">Work</button>');
        actions.prepend(nav);
        const apps = document.getElementById('titlebar-apps-btn');
        const label = document.createElement('span');
        label.textContent = 'Apps';
        apps.append(label);

        const hero = document.querySelector('.dash-agent-hero');
        const intro = document.createElement('header');
        intro.className = 'simple-intro';
        intro.innerHTML = '<p>Your personal AI</p><h1>What would you like to do?</h1>';
        hero.before(intro);
        const sections = document.createElement('div');
        sections.id = 'simple-home-sections';
        hero.after(sections);
        const shortcuts = document.createElement('nav');
        shortcuts.className = 'simple-app-shortcuts';
        shortcuts.setAttribute('aria-label', 'Frequently used apps');
        sections.before(shortcuts);

        const updates = document.createElement('div');
        updates.className = 'simple-updates';
        updates.innerHTML = `<button type="button" class="simple-updates-link" data-simple="updates">${this.icon('updates')}<span>Widgets</span>${this.icon('arrow')}</button>`;
        sections.after(updates);
        this.mountUpdates([intro, hero, shortcuts, sections, updates]);

        document.addEventListener('click', e => {
            const button = e.target.closest('[data-simple]');
            if (!button) return;
            const { simple, id } = button.dataset;
            if (simple === 'workrooms') { if (typeof WorkroomsApp !== 'undefined') WorkroomsApp.open(id || null); }
            if (simple === 'history') this.showHistory();
            if (simple === 'updates') AppManager.openAppFromLauncher('updates');
            // The post opens over whatever you are looking at (the overlay is
            // body-level), so the way back names home rather than the feed.
            if (simple === 'post' && typeof PromptFeed !== 'undefined') PromptFeed.openPost(id, { back: 'Home' });
            if (simple === 'settings') AppManager.openAppFromLauncher('settings');
            if (simple === 'chat') this.resume(id);
            if (simple === 'attention') {
                this._allAttention = !this._allAttention;
                this.render();
                document.querySelector('[data-simple="attention"]')?.focus();
            }
            if (simple === 'launch' && this.shortcuts().some(app => app.id === id)) AppManager.openAppFromLauncher(id);
            if (simple === 'journal' && AppManager.apps.journal) AppManager.openAppFromLauncher('journal');
            if (simple === 'agenda') AppManager.openAppFromLauncher(id === 'calendar' ? 'calendar' : 'actions');
            if (simple === 'review') this.review(id);
            if (simple === 'later') this.defer(id);
            if (simple === 'restore') this.defer(id, 0);
            if (simple === 'setup') {
                AppManager.openAppFromLauncher('settings');
                if (AppManager.currentApp === 'settings') SettingsApp.openCategory('accounts');
            }
        });
        this.mountHistory();
        const refresh = () => {
            if (AppManager.currentApp === null && !document.hidden) this.render();
            if (AppManager.currentApp === 'conversations') this.renderHistory();
        };
        document.addEventListener('anjadhe:data-changed', refresh);
        document.addEventListener('anjadhe:attention-changed', refresh);
        window.addEventListener('focus', refresh);
        this._attentionTimer = setInterval(refresh, 30000);
        // Refresh after store-cache invalidation; collapse a batch of writes.
        window.electronStore?.onKeyChanged?.(() => {
            clearTimeout(this._refreshTimer);
            this._refreshTimer = setTimeout(refresh, 100);
        });
    },

    onNavigate(appName) {
        if (!this.enabled) return;
        document.body.classList.toggle('simple-at-home', !appName || appName === 'home');
        document.querySelector('.simple-nav [data-simple="history"]')?.setAttribute('aria-current', appName === 'conversations' ? 'page' : 'false');
    },

    locked(app) {
        return AppManager.isAppLocked(app) && !AppManager.sensitiveUnlocked;
    },

    conversations() {
        if (this.locked('agent')) return [];
        // Use the service's private-chat filter; never read the raw blob here.
        return AgentService.getConversationList().filter(c => c.messageCount > 0)
            .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    },

    /**
     * "Log journal" beside the app pills, when it has been a few days
     * (2026-09-20, by request — the classic home has this and the simple
     * one did not). The RULE is AppManager.journalNudgeDue(), not a copy of
     * it, so the two homes can never disagree about the same fact.
     *
     * NOT gated on the app lock, though the sections below are. It first
     * was, and that was wrong twice over: the classic home's strip has
     * never checked, and the row this pill sits in already lists a locked
     * Journal as an ordinary shortcut — so the nudge was stricter than its
     * own neighbours. The lock guards CONTENT, and the nudge carries none:
     * it says you have not written, never a word of what you wrote, and
     * openApp still puts the unlock overlay in front of the door.
     */
    journalNudge() {
        try { return !!AppManager.journalNudgeDue?.(); } catch { return false; }
    },

    shortcuts() {
        const defaults = [{ id: 'email', label: 'Email' }, { id: 'calendar', label: 'Calendar' },
            { id: 'actions', label: 'Tasks' }, { id: 'portfolio', label: 'Portfolio' },
            { id: 'prompts', label: 'Routines' }];
        const catalog = typeof GlobalSearch !== 'undefined' ? GlobalSearch.allApps() : defaults;
        const hidden = AppManager.getHiddenApps?.() || new Set();
        // Email is a deliberate direct door in Simple mode. Other sub-apps
        // remain inside their parent, and permanent shell navigation stays out.
        const available = new Map(catalog.filter(app => AppManager.apps[app.id] && !hidden.has(app.id)
            && (!app.subappOf || app.id === 'email') && !['agent', 'settings', 'home', 'updates', 'conversations'].includes(app.id))
            .map(app => [app.id, { id: app.id, label: app.id === 'email' ? 'Email' : app.title || app.label }]));
        const ranked = AppManager.getFrequentApps?.(Infinity) || [];
        return [...new Set([...ranked, ...defaults.map(app => app.id)])]
            .filter(id => available.has(id)).slice(0, 5).map(id => available.get(id));
    },

    dayAhead(now = new Date()) {
        const rows = [];
        if (!this.locked('calendar') && typeof CalendarApp !== 'undefined') {
            CalendarApp.loadData();
            const accounts = new Set(CalendarApp.getAccounts().map(account => account.email));
            const horizon = new Date(now.getTime() + 24 * 60 * 60 * 1000);
            const events = (CalendarApp.events || []).filter(event => !event.allDay
                && event.status !== 'cancelled' && event.source !== 'schedule'
                && (accounts.has(event.account) || event.source === 'apple') && event.start && event.start < horizon
                && (event.end || event.start) > now).sort((a, b) => a.start - b.start);
            for (const event of events.slice(0, 2)) {
                const minutes = Math.max(1, Math.ceil((event.start - now) / 60000));
                const when = event.start <= now ? 'Happening now' : minutes < 60 ? `In ${minutes} min`
                    : `${event.start.toLocaleDateString([], { weekday: 'short' })} · ${event.start.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
                rows.push({ action: 'agenda', id: 'calendar', title: event.summary || 'Upcoming event', meta: when });
            }
        }
        if (!this.locked('actions') && !this.locked('schedule') && typeof ScheduleApp !== 'undefined') {
            ScheduleApp.loadData();
            const groups = ScheduleApp.getGroupedItems({ applySearch: false, applySidebarFilter: false });
            if (groups.overdue.length) rows.push({ action: 'agenda', id: 'actions',
                title: `${groups.overdue.length} overdue task${groups.overdue.length === 1 ? '' : 's'}`,
                meta: groups.overdue.slice(0, 2).map(task => task.title).join(' · ') });
            if (groups.todayActive.length) rows.push({ action: 'agenda', id: 'actions',
                title: `${groups.todayActive.length} task${groups.todayActive.length === 1 ? '' : 's'} for today`,
                meta: groups.todayActive.slice(0, 2).map(task => task.title).join(' · ') });
        }
        return rows;
    },

    /**
     * What the app did on its own — the home feed, reduced to one row per
     * routine. The full digest of series stays on the updates route, which
     * the "Widgets" link already points at; this is the focused version of it.
     *
     * NOTHING here writes a sentence about a post. The grouping into series,
     * the summary of the newest edition and the relative time are all
     * PromptFeed's own builders (docs/ROUTINES_UX.md: a summary is extracted
     * from the post, never model-written), so the row and the feed cannot
     * disagree about what a routine said.
     *
     * UNREAD only, and unread is the whole lifecycle: a quiet run posts
     * nothing (U3/U12) so it can never appear, opening a row marks it read
     * through the usual path, and the section then stops rendering — the
     * widget contract, applied to a shell section. An error card is honest
     * to show and is the one thing that stays: it can't be read, only
     * cleared, the same bargain it has in the feed.
     */
    routineUpdates(limit = 3) {
        if (typeof PromptFeed === 'undefined' || this.locked('prompts') || this.locked('notes')) return [];
        let series;
        try { series = PromptFeed._series(PromptFeed._scopedItems(true)); }
        catch { return []; }
        return series
            // "From nenva" announcements are not something a routine did.
            .filter(sc => !sc.published && sc.latest)
            // Cap BEFORE summarising: _summaryFor parses a post's HTML, and
            // the feed can hold ten editions of every routine the user has.
            .slice(0, limit)
            .map(sc => ({
                id: sc.latest.id,
                title: sc.title || 'A routine',
                summary: PromptFeed._summaryFor(sc.latest),
                when: PromptFeed._timeAgo(sc.latest.createdAt),
                error: !!sc.latest.error
            }));
    },

    routineRow(item) {
        const esc = UIUtils.escapeHtml;
        return `<button type="button" class="simple-row simple-home-row simple-routine-row" data-simple="post" data-id="${esc(item.id)}" title="${esc(item.title)}">
            <span class="simple-home-icon">${this.icon('routine')}</span>
            <span class="simple-home-copy"><span class="simple-home-title">${esc(item.title)}</span><span class="simple-row-meta">${esc(item.summary)}</span></span>
            <span class="simple-row-when">${item.error ? 'Did not finish' : esc(item.when)}</span>
        </button>`;
    },

    /**
     * A routine that stopped to ask something. Until it is answered the
     * routine has not finished, which makes it a real request for judgment
     * — the one thing Needs you is for. It reaches home on its own because
     * work() is scoped to the user's conversations and an ambient run has
     * none, so without this a routine could sit blocked all night with
     * nothing on the home page saying so.
     */
    routineAsks() {
        if (this.locked('prompts') || typeof TaskService === 'undefined') return [];
        return TaskService.list().filter(t => t && t.id && t.routineId
            && ['awaiting_user', 'paused'].includes(t.status));
    },

    routineTitle(id) {
        if (!id || typeof NotePrompts === 'undefined') return 'A routine';
        const title = String(NotePrompts.list().find(p => p.id === id)?.title || '').replace(/\s+/g, ' ').trim();
        if (!title) return 'A routine';
        return title.length > 48 ? title.slice(0, 48).replace(/\s+\S*$/, '') + '\u2026' : title;
    },

    work() {
        if (this.locked('agent')) return [];
        const conversations = new Set(this.conversations().map(c => c.id));
        return TaskService.list().filter(t => t.id && conversations.has(t.conversationId));
    },

    attention() {
        // A due date alone is not an AI finding. Only a real request for
        // judgment belongs here; ordinary schedule items stay in their apps.
        const chats = new Map(this.conversations().map(c => [c.id, c]));
        const pending = (AgentUI.pendingAttention?.() || []).filter(item => chats.has(item.conversationId))
            .map(item => ({ ...item, title: chats.get(item.conversationId).title || 'A decision for you', action: 'review' }));
        const rooms = typeof WorkroomsApp !== 'undefined' && WorkroomsApp.active() && !this.locked('agent')
            ? WorkroomsApp.rooms.filter(room => room.approval || room.status === 'paused' || (room.status === 'idle' && WorkroomsApp.unread(room))).map(room => ({ id: room.id, conversationId: null, kind: 'workroom', title: room.title, message: room.approval ? `${room.approval.summary} Open the workroom to answer.` : room.status === 'paused' ? 'This workroom is paused. Open it to continue.' : 'nenva replied in this workroom.', revision: room.updatedAt })) : [];
        const tasks = this.work().filter(t => t.status === 'awaiting_user').map(t => ({
            id: t.id, conversationId: t.conversationId, title: t.goal,
            message: this.workMessage(t), revision: t.updatedAt || t.createdAt || t.status,
            action: 'review'
        }));
        // A routine's own ask. Deduped against the list above, since a
        // routine run started from a conversation is in both.
        const seen = new Set(tasks.map(t => t.id));
        const asks = this.routineAsks().filter(t => !seen.has(t.id)).map(t => ({
            id: t.id, conversationId: t.conversationId || null, kind: 'routine',
            routineId: t.routineId, title: this.routineTitle(t.routineId),
            message: this.workMessage(t), revision: t.updatedAt || t.createdAt || t.status,
            action: 'review', actionLabel: 'Open the routine'
        }));
        return [...rooms, ...pending, ...tasks, ...asks];
    },

    workMessage(task) {
        const started = (task.plan || []).some(step => step.status !== 'pending');
        if (task.status === 'awaiting_user' && !started && task.plan?.length) return 'I have a plan ready. Please review it before I start.';
        if (task.status === 'awaiting_user') return (task.note || 'I need your approval before I can continue.')
            .replace(/ — open the task to continue\./g, '.');
        return { planning: 'I’m preparing a plan.', running: 'I’m working on this.', verifying: 'I’m checking the results.', paused: 'This work is paused. We can pick it up in the conversation.' }[task.status] || '';
    },

    deferrals() {
        try { return JSON.parse(localStorage.getItem('simple-attention-later') || '{}') || {}; }
        catch { return {}; }
    },

    deferredUntil(item, now = Date.now()) {
        const entry = this.deferrals()[item.id];
        return entry?.revision === item.revision && entry.until > now ? entry.until : 0;
    },

    defer(id, delay = 3600000) {
        const item = this.attention().find(item => item.id === id);
        if (!item) return;
        const entries = this.deferrals();
        // Keep only current requests. No conversation content is persisted.
        const live = new Set(this.attention().map(item => item.id));
        for (const key of Object.keys(entries)) if (!live.has(key)) delete entries[key];
        if (delay) entries[id] = { until: Date.now() + delay, revision: item.revision };
        else delete entries[id];
        try { localStorage.setItem('simple-attention-later', JSON.stringify(entries)); }
        catch { UIUtils.showToast?.('Could not save the reminder on this Mac.', 'error'); return; }
        this.render();
        Array.from(document.querySelectorAll(`[data-simple="${delay ? 'restore' : 'review'}"]`)).find(button => button.dataset.id === id)?.focus();
    },

    review(id) {
        const item = this.attention().find(item => item.id === id) || this.work().find(item => item.id === id);
        if (!item) return;
        if (item.kind === 'workroom') { WorkroomsApp.open(item.id); return; }
        // The routine page holds the question and its run history; the
        // widget's door, reused (js/apps/prompts/prompts-widget.js).
        if (item.kind === 'routine') {
            AppManager.openApp('prompts');
            if (AppManager.currentApp === 'prompts' && typeof PromptsApp !== 'undefined') PromptsApp.open({ id: item.routineId });
            return;
        }
        this.resume(item.conversationId);
        if (AppManager.currentApp !== 'agent') return;
        if (item.kind) { AgentUI.focusAttention(id); return; }
        const card = AgentUI._taskCards?.get(id);
        if (card) {
            card.tabIndex = -1;
            card.scrollIntoView({ block: 'center' });
            card.focus({ preventScroll: true });
        }
    },

    attentionMessage(item, deferred = false) {
        const esc = UIUtils.escapeHtml;
        const until = this.deferredUntil(item);
        return `<article class="simple-attention-message">
            <span class="simple-home-icon">${this.icon('chat')}</span><div class="simple-attention-copy">
            <h3>${esc(item.title || 'A decision for you')}</h3><p>${esc(item.message)}</p>
            ${deferred ? `<p class="simple-reminder-time">Shows again at <time datetime="${new Date(until).toISOString()}">${esc(new Date(until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }))}</time></p>` : ''}
            <div class="simple-message-actions"><button type="button" data-simple="review" data-id="${esc(item.id)}">${esc(item.actionLabel || 'Review together')}</button>
            <button type="button" data-simple="${deferred ? 'restore' : 'later'}" data-id="${esc(item.id)}">${deferred ? 'Show now' : 'Show again in 1 hour'}</button></div></div></article>`;
    },

    icon(name) {
        const paths = {
            chat: '<path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-3 2V11.5A8.5 8.5 0 0 1 9.5 3h3a8.5 8.5 0 0 1 8.5 8.5Z"/><path d="M7 9h8M7 13h5"/>',
            calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 11h18"/>',
            task: '<rect x="4" y="4" width="16" height="16" rx="4"/><path d="m8 12 3 3 5-6"/>',
            arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
            updates: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 7h8M8 11h8M8 15h4"/>',
            routine: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/><path d="M8 13h8"/><path d="M8 17h5"/>',
            connect: '<path d="m10 13 4-4m-6 6-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m2 2 1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0"/>'
        };
        return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.chat}</svg>`;
    },

    row({ action, id, title, meta }) {
        const esc = UIUtils.escapeHtml;
        return `<button type="button" class="simple-row simple-home-row" data-simple="${esc(action)}" data-id="${esc(id)}" title="${esc(title || 'Untitled')}"><span class="simple-home-icon">${this.icon(action === 'agenda' ? (id === 'calendar' ? 'calendar' : 'task') : action)}</span><span class="simple-home-copy"><span class="simple-home-title">${esc(title || 'Untitled')}</span>${meta ? `<span class="simple-row-meta">${esc(meta)}</span>` : ''}</span>${this.icon('arrow')}</button>`;
    },

    render() {
        if (!this.enabled) return;
        const host = document.getElementById('simple-home-sections');
        if (!host) return;
        const shortcuts = document.querySelector('.simple-app-shortcuts');
        if (shortcuts) {
            const nudge = this.journalNudge();
            // It leads the row, and Journal's own shortcut steps aside while
            // it is there — two pills to the same place, one of them asking.
            const apps = this.shortcuts().filter(app => !(nudge && app.id === 'journal'));
            const pills = (nudge ? '<button type="button" class="is-nudge" data-simple="journal" title="You haven\u2019t journaled in a while"><span class="simple-nudge-dot" aria-hidden="true"></span>Log journal</button>' : '')
                + apps.map(app => `<button type="button" data-simple="launch" data-id="${UIUtils.escapeHtml(app.id)}">${UIUtils.escapeHtml(app.label)}</button>`).join('');
            if (this._shortcutMarkup !== pills) { shortcuts.innerHTML = pills; this._shortcutMarkup = pills; }
        }
        const agenda = this.dayAhead();
        const attention = this.attention();
        const ready = attention.filter(item => !this.deferredUntil(item));
        const later = attention.filter(item => this.deferredUntil(item));
        const rows = this._allAttention ? ready : ready.slice(0, 3);
        const roomWork = typeof WorkroomsApp !== 'undefined' && WorkroomsApp.active() && !this.locked('agent') ? WorkroomsApp.rooms.filter(room => ['queued', 'running'].includes(room.status)).map(room => ({ id: room.id, goal: room.title, status: room.status, progress: WorkroomsApp.working(room), workroom: true })) : [];
        const working = [...roomWork, ...this.work().filter(t => ['planning', 'running', 'verifying', 'paused'].includes(t.status))];
        const workingOpen = host.querySelector('.simple-working')?.open;
        const updates = this.routineUpdates();
        const markup = `
            ${agenda.length ? `<section aria-labelledby="simple-day-title"><div class="simple-section-head"><h2 id="simple-day-title">On your radar</h2></div><div class="simple-sheet">${agenda.map(item => this.row(item)).join('')}</div></section>` : ''}
            ${rows.length ? `<section class="simple-attention" aria-labelledby="simple-attention-title"><div class="simple-section-head"><h2 id="simple-attention-title">Needs you</h2></div><div class="simple-sheet">${rows.map(r => this.attentionMessage(r)).join('')}</div>${ready.length > 3 ? `<button type="button" class="simple-more" data-simple="attention" aria-expanded="${!!this._allAttention}">${this._allAttention ? 'Show less' : `View all ${ready.length} messages`}</button>` : ''}</section>` : ''}
            ${later.length ? `<section class="simple-attention"><div class="simple-section-head"><h2>For later</h2></div><div class="simple-sheet">${later.map(r => this.attentionMessage(r, true)).join('')}</div></section>` : ''}
            ${updates.length ? `<section class="simple-routines" aria-labelledby="simple-routines-title"><div class="simple-section-head"><h2 id="simple-routines-title">From your routines</h2></div><div class="simple-sheet">${updates.map(u => this.routineRow(u)).join('')}</div></section>` : ''}
            ${working.length ? `<details class="simple-working" ${workingOpen ? 'open' : ''}><summary>Ongoing work <span>${working.length}</span></summary><div class="simple-sheet">${working.map(t => this.row({ action: t.workroom ? 'workrooms' : 'review', id: t.id, title: t.goal, meta: t.workroom ? t.progress : this.workMessage(t) })).join('')}</div></details>` : ''}
            ${!attention.length && !working.length && !agenda.length && !updates.length ? `<button type="button" class="simple-connect" data-simple="setup"><span class="simple-home-icon">${this.icon('connect')}</span><span>Connect your apps</span>${this.icon('arrow')}</button>` : ''}`;
        // Background refreshes must not discard keyboard focus on unchanged messages.
        if (this._homeMarkup !== markup) {
            this._homeMarkup = markup;
            host.innerHTML = markup;
        }

    },

    resume(id) {
        if (!this.conversations().some(c => c.id === id)) return;
        // The normal route owns app locks, history and stream subscriptions.
        AgentUI._continueConversationOnEnter = true;
        AppManager.openApp('agent');
        if (AppManager.currentApp !== 'agent') {
            AgentUI._continueConversationOnEnter = false;
            return;
        }
        AgentUI.closeProfilePanel();
        AgentService.loadConversation(id);
        AgentUI.renderAppView();
    },

    mountUpdates(homeElements) {
        const page = document.createElement('main');
        page.id = 'updates-view';
        page.className = 'view';
        page.setAttribute('aria-label', 'Updates');
        page.innerHTML = '<div class="dash-shell"><div class="dash-main"><div class="dashboard-container"></div></div></div>';
        const content = page.querySelector('.dashboard-container');
        // Move the original home content, keeping every id and listener. The
        // simple home keeps only its intro, existing composer and compact lists.
        const original = document.querySelector('#dashboard-view .dashboard-container');
        for (const child of Array.from(original.children)) {
            if (!homeElements.includes(child)) content.append(child);
        }
        document.getElementById('app-views').append(page);
        const scroller = page.querySelector('.dash-main');
        AppManager.register('updates', {
            render: () => {
                AppManager.renderDashHeader();
                AppManager.updateStats();
                Widgets.render(document.getElementById('dash-widgets'));
                PromptFeed.render();
                requestAnimationFrame(() => {
                    if (AppManager.currentApp === 'updates') scroller.scrollTop = this._updatesScroll || 0;
                });
            },
            onHide: () => { this._updatesScroll = scroller.scrollTop; }
        });
    },

    mountHistory() {
        const page = document.createElement('main');
        page.id = 'conversations-view';
        page.className = 'view app-view simple-history';
        page.setAttribute('aria-labelledby', 'simple-history-title');
        page.innerHTML = `<div class="simple-history-content">
            <header class="simple-history-header"><h1 id="simple-history-title">Conversations</h1><p>Pick up where you left off.</p></header>
            <input type="search" aria-label="Search conversations" placeholder="Search conversations…">
            <div class="simple-history-list"></div>
        </div>`;
        document.getElementById('app-views').append(page);
        this._historyPage = page;
        page.querySelector('input').addEventListener('input', () => {
            this._historyScroll = 0;
            this.renderHistory();
            page.scrollTop = 0;
        });
        AppManager.register('conversations', {
            render: () => {
                this.renderHistory();
                requestAnimationFrame(() => {
                    if (AppManager.currentApp !== 'conversations') return;
                    page.scrollTop = this._historyScroll || 0;
                    const selected = Array.from(page.querySelectorAll('[data-simple="chat"]'))
                        .find(el => el.dataset.id === this._historySelection);
                    (selected || page.querySelector('input')).focus({ preventScroll: true });
                });
            },
            onHide: () => { this._historyScroll = page.scrollTop; }
        });
        page.addEventListener('click', e => {
            const row = e.target.closest('[data-simple="chat"]');
            if (row) this._historySelection = row.dataset.id;
        });
    },

    showHistory() {
        AppManager.openAppFromLauncher('conversations');
    },

    historyBucket(iso, now = new Date()) {
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const yesterday = new Date(today);
        yesterday.setDate(yesterday.getDate() - 1);
        const time = new Date(iso).getTime();
        return time >= today.getTime() ? 'Today' : time >= yesterday.getTime() ? 'Yesterday' : 'Earlier';
    },

    historyPreview(conversation) {
        // User text only: never tool output, attachment data, or hidden reasoning.
        const message = (conversation?.messages || []).findLast(m => m.role === 'user');
        const content = message?.content;
        const text = typeof content === 'string' ? content : Array.isArray(content)
            ? content.filter(p => p.type === 'text').map(p => p.text || '').join(' ') : '';
        return text.replace(/\s+/g, ' ').trim().slice(0, 180);
    },

    renderHistory() {
        const page = this._historyPage;
        if (!page) return;
        const scroll = page.scrollTop;
        const esc = UIUtils.escapeHtml;
        const query = page.querySelector('input').value.trim().toLowerCase();
        // Only the service-approved saved list supplies ids. Private chats and
        // locked conversations never contribute previews or searchable text.
        const allowed = this.conversations();
        const byId = new Map((AgentService.conversations || []).map(c => [c.id, c]));
        const rows = allowed.map(c => ({ ...c, preview: this.historyPreview(byId.get(c.id)) }))
            .filter(c => `${c.title || ''} ${c.preview}`.toLowerCase().includes(query));
        let bucket = '';
        const groups = [];
        for (const c of rows) {
            const next = this.historyBucket(c.updatedAt);
            if (next !== bucket) {
                if (bucket) groups.push('</div></section>');
                groups.push(`<section class="simple-history-group" aria-label="${next}"><h2>${next}</h2><div class="simple-sheet">`);
                bucket = next;
            }
            groups.push(`<button type="button" class="simple-row simple-history-row" data-simple="chat" data-id="${esc(c.id)}">
                <span class="simple-history-copy"><span class="simple-history-title">${esc(c.title || 'Untitled')}</span>${c.preview ? `<span class="simple-history-preview">${esc(c.preview)}</span>` : ''}</span>
                <span class="simple-row-meta">${esc(AgentService.isConversationStreaming(c.id) ? 'Working' : AgentUI.formatTimeAgo(c.updatedAt))}</span>
            </button>`);
        }
        if (bucket) groups.push('</div></section>');
        page.querySelector('.simple-history-list').innerHTML = groups.length ? groups.join('')
            : `<p class="simple-empty">${this.locked('agent') ? 'Unlock your conversations to see your history.' : query ? 'No conversations match your search.' : 'Your saved conversations will appear here.'}</p>`;
        page.scrollTop = scroll;
    }
};
