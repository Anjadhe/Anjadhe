/**
 * The shell: the titlebar nav, the cards every thread reads (the raises and
 * their buttons), the day's schedule, the Chats and Jobs pages. Never changes
 * stored data, model routing or consent.
 *
 * Threads is the home page (2026-10-11, by request: "retire the now page and
 * make Threads page the home page"). The Now page is gone: its cards had
 * already moved into their threads (docs/SENDERS.md M7), and the day it kept
 * (Today, Coming up) is now the top of nenva's thread, drawn by ThreadsPage
 * from `schedule()`. Nothing here paints a page of its own any more;
 * `render()` repaints Threads.
 */
const SimpleExperience = {
    enabled: false,

    /** The one shell since 2026-10-05: the full shell and its switch are gone. */
    isOn() { return true; },

    init() {
        if (this.enabled) return;
        this.enabled = true;
        document.body.classList.add('simple-experience');

        // The nav lives in the titlebar's right (2026-10-11, by request: "the
        // left nav of the app can be retired if we can display the
        // navigation in the app's toolbar right"). Three doors and New chat
        // fit beside the window's name, and the page gets the whole width.
        // It was a 220px left rail from 2026-10-01 (ported from nenva
        // desktop), collapsible to icons from 2026-10-10.
        const nav = document.createElement('nav');
        nav.className = 'nv-topnav';
        nav.setAttribute('aria-label', 'Main navigation');
        nav.innerHTML = `<div class="nv-items">${this.navItems().map(([id, label, icon]) => `<button type="button" data-simple="nav" data-id="${id}" title="${label}">${this.icon(icon)}<span>${label}</span></button>`).join('')}</div>
            <button type="button" class="nv-new" data-simple="new-chat" title="New chat" aria-label="New chat"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg><span>New chat</span></button>`;
        document.querySelector('.titlebar-actions').append(nav);
        // No Apps switcher in this shell's titlebar (2026-10-01, by request:
        // "Remove the apps switcher from app's toolbar"). Home's buttons,
        // Memory and ⌘K are the doors; css hides the button.

        document.addEventListener('click', e => {
            const button = e.target.closest('[data-simple]');
            if (!button) return;
            const { simple, id } = button.dataset;
            if (simple === 'card-open-conv') { this.resume(id); return; }
            if (simple === 'card-chat') { this.openCardChat(id); return; }
            if (simple === 'card-undo-scope') {
                if (typeof WriteLedger !== 'undefined') WriteLedger.undoScope(id).then(() => { if (typeof UIUtils !== 'undefined') UIUtils.showToast('Undone', 'success'); this.render(); }).catch(e => console.warn('[now] undo failed:', e));
                return;
            }
            if (simple === 'history') this.showHistory();
            if (simple === 'routine' && typeof PromptsApp !== 'undefined') PromptsApp.open({ id });
            if (simple === 'routine-new' && typeof PromptsApp !== 'undefined') PromptsApp.askNewRoutine();
            if (simple === 'nav') this.go(id);
            if (simple === 'card') this.cardAct(id, button.dataset.act);
            if (simple === 'job') this.openJob(id);
            // A new chat is a new conversation in nenva's thread (M7).
            if (simple === 'new-chat') {
                if (typeof ThreadsPage !== 'undefined') { ThreadsPage.open('nenva'); ThreadsPage.newNenvaConversation(); }
                else { AppManager.openAppFromLauncher('agent'); if (AppManager.currentApp === 'agent' && typeof AgentUI !== 'undefined') AgentUI.newChat(); }
            }

            // The post opens over whatever you are looking at (the overlay is
            // body-level), so the way back names home rather than the feed.
            if (simple === 'post' && typeof PromptFeed !== 'undefined') PromptFeed.openPost(id, { back: 'Threads' });
            if (simple === 'settings') AppManager.openAppFromLauncher('settings');
            if (simple === 'chat') this.resume(id);
            if (simple === 'review') this.review(id);
            // A prepared follow-up's "Not now" (docs/PROACTIVE.md: final).
            if (simple === 'dismiss' && typeof Proactive !== 'undefined') { Proactive.dismiss(id); this.render(); }
        });
        this.mountHistory();
        this.mountJobs();
        if (typeof SimpleSettings !== 'undefined') SimpleSettings.mount();
        if (typeof ThreadsPage !== 'undefined') ThreadsPage.mount();
        const refresh = () => {
            if (AppManager.currentApp === 'conversations') this.renderHistory();
            if (AppManager.currentApp === 'jobs') this.renderJobs();
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

    // Now · Chats · Settings (2026-10-06, the simplification, docs/VISION.md
    // review log). Widgets, Jobs and Routines left the nav that day: Now is
    // the one surface; a job is its chat's (its status rides the chat's row
    // on Chats; the job view is reached from the chat, a Now card or a
    // notification); a routine is a STANDING chat (listed on Chats with its
    // trigger and last run; its detail opens from there; changes and
    // set-up are conversations).
    // Pinned joined 2026-10-09 (by request): the commitments the person
    // pinned, each a shortcut to its own page (js/core/pins.js).
    // Threads joined 2026-10-10 (an experiment): every folder nenva keeps
    // as a sender in a Messages-style page (js/core/threads-page.js).
    // Threads is the core (2026-10-10, docs/SENDERS.md M7): Pinned folded
    // into Threads (pins first); Chats left the nav, and its routines, every
    // chat as a list and a private chat are reached from nenva's info page
    // in Threads. Now left 2026-10-11 (by request): Threads is the home
    // page, and the day Now kept is the top of nenva's thread.
    NAV: [['threads', 'Threads', 'bubbles'], ['memory', 'Memory', 'drive'], ['settings', 'Settings', 'sliders']],
    /** The nav. Commitments left it 2026-10-05 (by request): its door is a
     *  row on Memory. Memory joined it 2026-10-07 (Ram: "does it make sense
     *  to show memory as a left nav item"): what nenva keeps for the person
     *  — facts, commitments, the folders from mail, taught tasks — is the
     *  vision's third noun and gets the third slot; Settings is configuration. */
    navItems() { return this.NAV; },

    /** Which nav item a page belongs to (a chat keeps Threads lit). Home is Threads. */
    navKey(appName) {
        if (!appName || appName === 'home') return 'threads';
        if (['conversations', 'agent', 'jobs', 'prompts'].includes(appName)) return 'threads';
        if (appName === 'threads') return 'threads';
        // Memory's pages: the Memory page itself (a Settings page), Commitments,
        // the folders list and a folder's page, Taught tasks.
        if (['commitments', 'fyi', 'matter', 'portfolio', 'notes', 'documents', 'reader'].includes(appName)) return 'memory';
        if (appName === 'simplesettings' && typeof SimpleSettings !== 'undefined' && SimpleSettings._page === 'pinned') return 'threads';
        if (appName === 'simplesettings' && typeof SimpleSettings !== 'undefined' && ['memory', 'taught'].includes(SimpleSettings._page)) return 'memory';
        if (['settings', 'simplesettings'].includes(appName)) return 'settings';
        return null;
    },

    go(id) {
        if (id === 'threads') AppManager.showDashboard();
        else if (id === 'commitments' && typeof CommitmentsPage !== 'undefined') CommitmentsPage.open();
        else if (id === 'memory' && typeof SimpleSettings !== 'undefined') SimpleSettings.open('memory');
        else if (id === 'pinned' && typeof SimpleSettings !== 'undefined') SimpleSettings.open('pinned');
        else if (id === 'settings' && typeof SimpleSettings !== 'undefined') {
            // The simple Settings (2026-10-01), built one row at a time;
            // "All settings" there opens the full SettingsApp.
            SimpleSettings.open('root');
        } else if (id === 'settings') {
            AppManager.openAppFromLauncher('settings');
            if (AppManager.currentApp === 'settings' && typeof SettingsApp !== 'undefined') SettingsApp.showRoot?.();
        }
    },

    onNavigate(appName) {
        if (!this.enabled) return;
        const key = this.navKey(appName);
        document.querySelectorAll('.nv-items [data-simple="nav"]').forEach(b => {
            b.classList.toggle('is-on', b.dataset.id === key);
            b.setAttribute('aria-current', b.dataset.id === key ? 'page' : 'false');
        });
    },

    locked(app) {
        return AppManager.isAppLocked(app) && !AppManager.sensitiveUnlocked;
    },

    conversations() {
        if (this.locked('agent')) return [];
        // Use the service's private-chat filter; never read the raw blob here.
        // A routine run's throwaway conversation (AgentService.runHeadless,
        // id `ephemeral_…`) is in the list only while it runs; it is the
        // routine's, which Chats lists under Standing, never a chat — and
        // so is a Standing conversation itself (the routine, 2026-10-07).
        return AgentService.getConversationList().filter(c => c.messageCount > 0 && !c.standing && !/^ephemeral_/.test(String(c.id || '')))
            .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
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
     * widget contract, applied to a shell section. A failed run is not an
     * update (docs/ROUTINES_UX.md I7, 2026-10-09): it is counted by the
     * engine and only a routine that keeps failing reaches Now, once
     * (RoutineFailures).
     */
    routineUpdates(limit = 3) {
        if (typeof PromptFeed === 'undefined' || this.locked('prompts') || this.locked('agent')) return [];
        let series;
        try { series = PromptFeed._series(PromptFeed._scopedItems(true)); }
        catch { return []; }
        return series
            // "From nenva" announcements are not something a routine did.
            // A failed run is not an update (I7): RoutineFailures speaks for a
            // routine that keeps failing; an old error message stays in its chat.
            .filter(sc => !sc.published && sc.latest && !sc.latest.error)
            // Cap BEFORE summarising: _summaryFor parses a post's HTML, and
            // the feed can hold ten editions of every routine the user has.
            .slice(0, limit)
            .map(sc => ({
                id: sc.latest.id,
                promptId: sc.latest.promptId || null,
                title: sc.title || 'A routine',
                summary: PromptFeed._summaryFor(sc.latest),
                when: PromptFeed._timeAgo(sc.latest.createdAt),
                error: !!sc.latest.error,
                // A scheduled look's report (RoutineLook): its own headline
                // and changes, and whether it asked for a card (I6).
                look: sc.latest.look || null
            }));
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
        if (this.locked('prompts') || typeof TeamJobs === 'undefined') return [];
        return TeamJobs.all().filter(t => t && t.id && t.routineId && t.engine === 'team'
            && ['awaiting_user', 'paused'].includes(t.status));
    },

    routineTitle(id) {
        if (!id || typeof NotePrompts === 'undefined') return 'A routine';
        const title = String(NotePrompts.list().find(p => p.id === id)?.title || '').replace(/\s+/g, ' ').trim();
        if (!title) return 'A routine';
        return title.length > 48 ? title.slice(0, 48).replace(/\s+\S*$/, '') + '\u2026' : title;
    },

    /**
     * "From your email" (2026-10-01). A friend connected Gmail, looked at
     * this home, and saw nothing change: the insights were on the Updates
     * page behind "Widgets", and the first read of the mailbox takes a few
     * minutes with nothing saying it was under way. Now the home says it is
     * reading, then shows what it found, using the SAME selection as the
     * "Needs a look" card (EmailHome.unreadInsights in email-widget.js).
     *
     * The progress line is for the first days after a connect, or a real
     * backlog; a couple of new emails being read in steady state is not
     * news. A blocked queue says why instead of claiming to read.
     */
    FIRST_DAYS_MS: 2 * 86400000,
    BACKLOG_WORTH_SHOWING: 10,

    recentlyConnected(now = Date.now()) {
        if (typeof AccountsManager === 'undefined') return false;
        return AccountsManager.getAll().some(a => a?.services?.mail && a.connectedAt
            && now - Date.parse(a.connectedAt) < this.FIRST_DAYS_MS);
    },

    emailHome() {
        if (typeof EmailHome === 'undefined' || this.locked('fyi') || this.locked('email')) return null;
        const p = EmailHome.progress();
        if (!p.connected) return null;
        // Where reading stands, for the status line and the note; what mail
        // NEEDS of the person is the folder cards (docs/MATTERS.md §17).
        const firstDays = this.recentlyConnected();
        const queued = p.queued || 0;
        const reading = firstDays ? (p.loading || queued > 0) : queued >= this.BACKLOG_WORTH_SHOWING;
        const blocked = reading && !p.loading ? p.blocked : null;
        const caughtUp = firstDays && !reading;
        if (!reading && !caughtUp) return null;
        return { reading, loading: !!p.loading, queued, blocked, caughtUp };
    },


    work() {
        if (this.locked('agent')) return [];
        const conversations = new Set(this.conversations().map(c => c.id));
        return this._allJobs().filter(t => t.id && conversations.has(t.conversationId));
    },

    attention() {
        // A due date alone is not an AI finding. Only a real request for
        // judgment belongs here; ordinary schedule items stay in their apps.
        const chats = new Map(this.conversations().map(c => [c.id, c]));
        const pending = (AgentUI.pendingAttention?.() || []).filter(item => chats.has(item.conversationId))
            .map(item => ({ ...item, title: chats.get(item.conversationId).title || 'A decision for you', action: 'review' }));
        // A chat job's approval is a chat ask (pendingAttention above), so only
        // the task engine's own waits are listed here.
        const tasks = this.work().filter(t => t.status === 'awaiting_user' && t.engine !== 'team').map(t => ({
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
        // Follow-ups the assistant drafted (docs/PROACTIVE.md): a prepared
        // reply waiting for approval is a request for judgment.
        const followups = typeof Proactive !== 'undefined' && typeof FEATURES !== 'undefined'
            && FEATURES.isEnabled('proactive') ? Proactive.attentionItems() : [];
        return [...pending, ...tasks, ...asks, ...followups];
    },

    workMessage(task) {
        // A chat job's line is built from its room's events (TeamJobs.asJob).
        if (task.engine === 'team') return task.note || '';
        const started = (task.plan || []).some(step => step.status !== 'pending');
        if (task.status === 'awaiting_user' && !started && task.plan?.length) return 'I have a plan ready. Please review it before I start.';
        if (task.status === 'awaiting_user') return (task.note || 'I need your approval before I can continue.')
            .replace(/ — open the task to continue\./g, '.');
        return { planning: 'I’m preparing a plan.', running: 'I’m working on this.', verifying: 'I’m checking the results.', paused: 'This work is paused. We can pick it up in the conversation.' }[task.status] || '';
    },




    review(id) {
        const item = this.attention().find(item => item.id === id) || this.work().find(item => item.id === id);
        if (!item) return;
        if (item.kind === 'followup') { Proactive.open(item.id); return; }
        // The routine page holds the question and its run history; the
        // widget's door, reused (js/apps/prompts/prompts-widget.js).
        // A routine's team job: its page holds the change and Allow / Don't allow.
        if (item.kind === 'routine' && typeof TeamJobs !== 'undefined' && TeamJobs.isJob(item.id)) { this.openJob(item.id); return; }
        if (item.kind === 'routine') {
            AppManager.openApp('prompts');
            if (AppManager.currentApp === 'prompts' && typeof PromptsApp !== 'undefined') PromptsApp.open({ id: item.routineId });
            return;
        }
        this.resume(item.conversationId);
        if (AppManager.currentApp !== 'agent') return;
        if (item.kind) { AgentUI.focusAttention(id); return; }
        const card = document.querySelector(`[data-job-strip="${String(id).replace(/["\\]/g, '')}"]`);
        if (card) {
            card.tabIndex = -1;
            card.scrollIntoView({ block: 'center' });
            card.focus({ preventScroll: true });
        }
    },


    icon(name) {
        const paths = {
            clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
            pin: '<path d="M12 17v5"/><path d="M9 3h6l-1 6 3 3v2H7v-2l3-3z"/>',
            drive: '<path d="M3 13l3-8h12l3 8"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 16.5h.01M11 16.5h.01"/>',
            sliders: '<path d="M4 7h3m4 0h9M4 17h9m4 0h3"/><circle cx="9" cy="7" r="2"/><circle cx="15" cy="17" r="2"/>',
            bubbles: '<path d="M3 11a7 7 0 0 1 7-7h1a7 7 0 0 1 0 14H7l-4 3z"/><path d="M15.5 18.5A6 6 0 0 0 21 21l-1.5-3A6 6 0 0 0 18 8"/>',
            chat: '<path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-3 2V11.5A8.5 8.5 0 0 1 9.5 3h3a8.5 8.5 0 0 1 8.5 8.5Z"/><path d="M7 9h8M7 13h5"/>',
            calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 11h18"/>',
            task: '<rect x="4" y="4" width="16" height="16" rx="4"/><path d="m8 12 3 3 5-6"/>',
            arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
            routine: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/><path d="M8 13h8"/><path d="M8 17h5"/>',
            chevron: '<path d="m9 6 6 6-6 6"/>',
            mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m4 7 8 6 8-6"/>',
            close: '<path d="M6 6l12 12M18 6 6 18"/>',
            connect: '<path d="m10 13 4-4m-6 6-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m2 2 1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0"/>'
        };
        return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.chat}</svg>`;
    },


    /**
     * NEXT — what needs the person, one row each, ONE action per row (the
     * primary pill); clicking the title opens the thing itself. Order, as
     * nenva ranks it: requests for judgment (asks, approvals, prepared
     * follow-ups, routine questions), then overdue tasks, then what the
     * email read found, then the offer to connect email. Each row carries
     * everything its two doors need; nothing here is model-written.
     */
    nextRows() {
        const rows = [];
        for (const item of this.attention()) {
            rows.push({ kind: 'ask', id: item.id, title: item.title || 'A decision for you',
                detail: item.message || '', action: item.actionLabel || 'Review', urgent: true,
                dismiss: item.dismissLabel || '' });
        }
        if (typeof Commitments !== 'undefined' && Commitments._inited) {
            try {
                const today = Commitments.today();
                for (const c of Commitments.all()) {
                    if (!c || c.state !== 'open' || Commitments.repeats(c) || !c.when || !c.when.date || c.when.date >= today) continue;
                    if ((c.privacySources || []).includes('slack')) continue;
                    const d = new Date(c.when.date + 'T00:00:00');
                    rows.push({ kind: 'task', id: c.id, title: c.title || 'A task',
                        detail: `Was due ${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}`,
                        due: c.when.date, matter: c.origin && c.origin.kind === 'matter' ? c.origin.ref : null,
                        action: 'Done', urgent: true });
                }
            } catch { /* commitments unavailable */ }
            // A repeat's last day with nothing said about it (2026-10-08, Ram:
            // "i had a plant watering task yesterday which i did not … i dont
            // see that today"). A repeat was never overdue: on a day it does
            // not happen it simply vanished until its next day.
            if (this._commitmentsOn()) { try { rows.push(...this.missedRows(Commitments.all(), Commitments.today())); } catch { /* commitments unavailable */ } }
        }
        const email = this.emailHome();
        if (email?.blocked) {
            const line = EmailHome.statusLine({ connected: true, queued: email.queued, blocked: email.blocked });
            if (line) rows.push({ kind: 'fix', id: line.fix, title: line.title, detail: line.meta, action: 'Open Settings' });
        }
        // What mail and texts need of the person rides the folder cards
        // (Matters); there is no per-message row since 2026-10-07 (docs/MATTERS.md §17).
        const connected = typeof EmailHome === 'undefined' || EmailHome.progress().connected;
        if (!connected && !this.locked('fyi')) {
            rows.push({ kind: 'connect', id: 'google', title: 'Connect your email and calendar',
                detail: 'nenva reads your recent email and brings what needs you here.', action: 'Connect' });
        }
        return rows;
    },

    /**
     * The last day of each repeat that passed with no mark and no words
     * (Commitments' facts), as overdue rows. Pure over `all` and `today`.
     * Code states the fact ("Not marked Tue, Oct 7") and the person answers
     * it; it never says the day was missed. Shown only until the repeat's
     * next day (today's row then stands for it), for days within two weeks,
     * and not for a repeat whose days AskAfter asks about or a work session.
     */
    missedRows(all, today) {
        const C = Commitments;
        const lo = C.iso(new Date(Date.parse(`${today}T12:00:00`) - 14 * 86400000));
        const yday = C.iso(new Date(Date.parse(`${today}T12:00:00`) - 86400000));
        const out = [];
        for (const c of all) {
            if (c.state !== 'open' || !C.repeats(c) || C.occursOn(c, today)) continue;
            if (c.origin && c.origin.kind === 'plan') continue;
            if (c.read && c.read.askAfter && !c.read.stopAsk) continue;
            const day = C.recentDays(c, yday, 1)[0];
            if (!day || day < lo || !C.occursOn(c, day)) continue;
            if ((c.history && c.history[day]) || (c.log && c.log[day] && c.log[day].length)) continue;
            const d = new Date(`${day}T12:00:00`);
            out.push({ kind: 'task', id: c.id, title: c.title || 'A task', missedDay: day, due: day, action: 'Done', urgent: true,
                detail: `Not marked ${day === yday ? 'yesterday' : d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}` });
        }
        return out;
    },

    /** Mark a repeat's past day (a missed row's answer), with Undo. */
    _markMissed(row, how) {
        const r = Commitments.report(row.id, { day: row.missedDay, how }, { by: 'you', why: 'answered a past day' });
        if (r.ok && r.ledgerId && typeof UIUtils !== 'undefined') {
            UIUtils.showToast(`${how === 'done' ? 'Marked done' : 'Marked skipped'}: ${row.title}`, 'success', 6000, { actionLabel: 'Undo', onAction: () => { Commitments.undo(r.ledgerId); this.render(); } });
        }
        this.render();
        return r;
    },

    /**
     * Open a NEXT row (2026-10-01: rows carry no buttons, by request; the
     * actions live on what a row opens). `act` remains for callers that
     * want the primary action directly (tests, keyboard shortcuts).
     */
    nextAct(id, act) {
        const row = this.nextRows().find(r => `${r.kind}:${r.id}` === id);
        if (!row) return;
        if (row.kind === 'ask') { this.review(row.id); return; }
        if (row.kind === 'task') {
            if (act && row.missedDay) { this._markMissed(row, 'done'); return; }
            if (act) {
                const r = Commitments.setDone(row.id, true, { by: 'you' });
                if (r.ok && r.ledgerId && typeof UIUtils !== 'undefined') UIUtils.showToast(`Marked done: ${row.title}`, 'success', 6000, { actionLabel: 'Undo', onAction: () => { Commitments.undo(r.ledgerId); this.render(); } });
                this.render(); return;
            }
            if (typeof ThreadsPage !== 'undefined') ThreadsPage.open(`task:${row.id}`);
            return;
        }
        if (row.kind === 'fix') {
            // 'ai' = the brain, 'privacy' = what may leave (email-widget.js): pages of Settings (2026-10-06).
            SimpleSettings.open(row.id === 'ai' ? 'model' : 'privacy');
            return;
        }
        if (row.kind === 'connect') {
            if (typeof SettingsApp !== 'undefined' && SettingsApp._connectGoogleAccount && window.electronAccounts) SettingsApp._connectGoogleAccount();
            else SimpleSettings.open('connectors');
        }
    },

    /**
     * The same thing from several calendars is ONE row (2026-10-07, Ram:
     * four connected calendars each carry a holiday calendar, so Columbus
     * Day showed four times). Arithmetic: on one day, the same title (case
     * and spacing aside) at the same time is one row; the first kept, and a
     * row with a door wins over one without. Different times stay apart.
     */
    _oneOfEach(rows) {
        const seen = new Map();
        const out = [];
        for (const r of rows) {
            const k = `${String(r.title || '').trim().toLowerCase().replace(/\s+/g, ' ')}|${r.time || ''}`;
            const prev = seen.get(k);
            if (prev === undefined) { seen.set(k, out.length); out.push(r); }
            else if (!out[prev].open && r.open) out[prev] = r;
        }
        return out;
    },

    /** TODAY — the day's timed events, then today's tasks, as one line. */
    todayItems(now = new Date()) {
        const items = [];
        if (!this.locked('calendar') && typeof CalendarApp !== 'undefined') {
            try {
                CalendarApp.loadData();
                const accounts = new Set(CalendarApp.getAccounts().map(a => a.email));
                const end = new Date(now); end.setHours(23, 59, 59, 999);
                const events = (CalendarApp.events || []).filter(e => e.status !== 'cancelled' && e.source !== 'schedule'
                    && (accounts.has(e.account) || e.source === 'apple') && e.start && e.start <= end && (e.end || e.start) > now)
                    .sort((x, y) => x.start - y.start);
                for (const e of events) {
                    // Where it opens: the calendar it was synced from
                    // (2026-10-01, by request) — Google's own event page,
                    // or the event in Calendar.app for an Apple one.
                    const open = e.source === 'apple'
                        ? (e.appleEventId ? { apple: e.appleEventId } : null)
                        : (e.htmlLink && /^https:\/\//i.test(e.htmlLink) ? { url: e.htmlLink } : null);
                    const mt = typeof Matters !== 'undefined' ? Matters.forCalendarEvent(e.id) : null;
                    // An event with a folder opens the folder's page (2026-10-07,
                    // by request: the same thing opened in Google Calendar from
                    // here and on its page from a Now card); the calendar is a
                    // row there. An event with no folder has nothing in nenva
                    // to show and keeps opening in its calendar.
                    items.push({ time: e.allDay ? '' : e.start.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }), title: e.summary || 'Event', open: mt ? { matter: mt.id } : open,
                        mins: e.allDay ? Infinity : e.start.getHours() * 60 + e.start.getMinutes(),
                        ev: e, key: `event:${e.id}`, help: (mt && this._matterHelp(mt)) || this._eventHelp(e, now) });
                }
            } catch { /* calendar unavailable */ }
        }
        if (typeof Commitments !== 'undefined' && Commitments._inited) {
            try {
                const day = this._iso(now);
                for (const c of this._commitmentsOn_(day)) {
                    // A commitment from a message whose item the assistant
                    // linked to a calendar event, and which asks nothing more,
                    // is the calendar row twice: the calendar row stands for it.
                    const o = c.origin || {};
                    if ((o.kind === 'email' || o.kind === 'text') && o.ref && typeof EmailApp !== 'undefined' && EmailApp.coveredByCalendar
                        && EmailApp.coveredByCalendar(EmailApp.emailById ? EmailApp.emailById(o.ref) : null)) continue;
                    const at = this._clockRow(Commitments.timeOn(c, day).time);
                    items.push({ time: at.time, title: c.title, mins: at.mins,
                        open: { task: c.id }, taskId: c.id, key: `task:${c.id}`, help: this._taskHelp(c) });
                }
            } catch { /* commitments unavailable */ }
        }
        // A folder's step due today (a bill's day): mail makes folders, not tasks.
        for (const { m, step } of this._stepsDueOn(this._iso(now))) {
            if (m.kind === 'appointment' && !m.calendarEventId && m.when && m.when.date === this._iso(now)) continue;   // its row comes below
            const at = this._clockRow(step.time);
            let help = null;
            try { help = this._matterHelp(m); } catch { help = null; }
            items.push({ time: at.time, title: Matters.titleOf(m), mins: at.mins, key: this._matterKey(m.id), open: { matter: m.id }, help });
        }
        // An appointment the calendar does not hold yet is still on the day.
        if (typeof Matters !== 'undefined' && !this.locked('fyi')) {
            const todayIso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
            for (const mt of Matters.upcoming(now.getTime())) {
                // Appointments only: a bill's day is its pay task's row.
                if (mt.kind !== 'appointment' || mt.calendarEventId || mt.when.date !== todayIso) continue;
                const t = Matters._hm(mt.when.time);
                const at = t === null ? null : new Date(now.getFullYear(), now.getMonth(), now.getDate(), Math.floor(t / 60), t % 60);
                if (at && at < now) continue;
                items.push({ time: at ? at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '', title: Matters.titleOf(mt),
                    mins: t === null ? Infinity : t, key: this._matterKey(mt.id), open: { matter: mt.id }, help: this._matterHelp(mt) });
            }
        }
        const once = this._oneOfEach(items);
        // A row whose help nenva is already giving (a chat or a job started
        // from it) says what that work is doing instead of offering it again.
        for (const it of once) {
            const w = this._todayWork(it.key);
            if (w) it.help = w;
        }
        // The assistant looks at the day's rows once they are known, and
        // again only when they change (TodayHelp.judge); its answer repaints.
        if (typeof TodayHelp !== 'undefined') {
            clearTimeout(this._todayJudge);
            this._todayJudge = setTimeout(() => TodayHelp.judge(() => { this.render(); }).catch(() => {}), 500);
        }
        // The day in order: timed items by time, then "Anytime".
        return once.sort((a, b) => a.mins - b.mins).slice(0, 8);
    },

    // ── Today, agentic (2026-10-01; js/core/today-help.js, laws H1–H3) ──

    /**
     * A title short enough for a sentence: the part before a bracket, dash or
     * long number, then at most `max` characters at a word boundary.
     */
    shortTitle(title, max = 44) {
        let t = String(title || '').replace(/\s+/g, ' ').trim();
        const cut = t.search(/\s(?:\(|[—–]|-\s|#?\d{6,})/);
        if (cut >= 12) t = t.slice(0, cut).trim();
        if (t.length > max) t = t.slice(0, max).replace(/\s+\S*$/, '').replace(/[,;:]$/, '') + '…';
        return t;
    },

    /** An appointment's matter on its Today row: its step, its draft. */
    _matterHelp(mt) {
        const step = Matters.openStep(mt);
        const n = Matters.messagesOf(mt).length;
        const line = [Matters.stepText(mt), n > 1 ? `${n} messages about it` : ''].filter(Boolean).join(' · ');
        if (!step) return line ? { line, action: null } : null;
        return { line, action: { label: Matters.actionLabel(step), kind: 'matter', id: mt.id, step: step.id } };
    },

    /**
     * The work a Today row started (2026-10-02, reported: "Find options" ran
     * as a job and the row said nothing about it). A chat started from a row
     * carries `todayKey` (`task:<id>` / `event:<id>`); its latest job, or the
     * chat itself, replaces the row's offer with what is happening and a door
     * to it. Words are the job status's own (jobStatus / workMessage).
     */
    _todayWork(key, now = Date.now()) {
        if (!key || this.locked('agent') || typeof AgentService === 'undefined') return null;
        // The list is summaries; the link lives on the conversation itself.
        const listed = new Set(this.conversations().map(c => c.id));
        const conv = (AgentService.conversations || [])
            .filter(c => listed.has(c.id) && c.todayKey === key && now - Date.parse(c.updatedAt || c.createdAt || 0) < 3 * 86400000)
            .sort((a, b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0))[0];
        if (!conv) return null;
        const job = this._allJobs()
            .filter(t => t && t.conversationId === conv.id)
            .sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0))[0];
        if (job) {
            const st = this.jobStatus(job);
            const msg = this.workMessage(job) || (job.status === 'done' ? (job.note || 'Finished.') : job.note || '');
            const label = job.status === 'awaiting_user' ? 'Review' : ['planning', 'running', 'verifying'].includes(job.status) ? 'See progress' : 'See results';
            return { line: `${st.label}${msg ? `: ${String(msg).replace(/\s+/g, ' ').slice(0, 140)}` : ''}`, live: !!st.live, attn: !!st.attn,
                action: { label, kind: 'job', id: job.id } };
        }
        const streaming = AgentService.isConversationStreaming && AgentService.isConversationStreaming(conv.id);
        return { line: streaming ? 'Working on it in a chat.' : `In a chat, ${this.agoLabel(Date.parse(conv.updatedAt || conv.createdAt), new Date(now))}.`,
            live: !!streaming, action: { label: 'Open chat', kind: 'conv', id: conv.id } };
    },
    _eventHelp(e, now = new Date()) {
        if (typeof TodayHelp === 'undefined') return null;
        try {
            const P = typeof Proactive !== 'undefined' ? Proactive : null;
            const facts = P ? P.prepFacts(e, P._emails(), now.getTime()) : null;
            const prep = P && P.prepLineFor ? P.prepLineFor(e) : null;
            const ED = typeof EventDetails !== 'undefined' ? EventDetails : null;
            return TodayHelp.helpFor(TodayHelp.eventOptions(e, { key: `event:${e.id}`, facts, prep, meeting: ED ? ED.meetingOf(e) : null, mapUrl: ED ? ED.mapUrl(e) : '' }, now.getTime()));
        } catch { return null; }
    },

    /** A commitment's Today help (TodayHelp reads a small task-shaped view). */
    _taskHelp(c) {
        if (typeof TodayHelp === 'undefined') return null;
        try {
            const o = c.origin || {};
            let email = null;
            if ((o.kind === 'email' || o.kind === 'text') && o.ref && typeof EmailApp !== 'undefined' && !this.locked('email')) {
                const m = EmailApp.emailById ? EmailApp.emailById(o.ref) : null;
                // Who sent it, and the amount / date the email analysis found.
                const an = (EmailApp.priorityAnalyses || {})[o.ref] || {};
                const fromRaw = o.from || (m && m.from) || '';
                const sender = typeof Proactive !== 'undefined' && Proactive.name ? Proactive.name(fromRaw) : String(fromRaw).replace(/<.*>/, '').replace(/"/g, '').trim();
                const insight = Array.isArray(an.insights) ? an.insights.find(x => x && (x.dueDate || x.amount)) : null;
                email = { id: o.ref, subject: (m && m.subject) || o.subject || '', sender,
                    amount: an.amount || (insight && insight.amount) || null, due: an.dueDate || (insight && insight.dueDate) || null };
            }
            const parent = c.parent ? Commitments.get(c.parent) : null;
            const project = parent && parent.state === 'open' ? { title: parent.title } : null;
            const view = { id: c.id, title: c.title, repeat: (c.repeat && c.repeat.rule) || 'none', description: c.note || '' };
            return TodayHelp.helpFor(TodayHelp.taskOptions(view, { key: `task:${c.id}`, email, project }));
        } catch { return null; }
    },

    /** The day line over TODAY (H3): meetings left, clashes, free time. */
    todayLine(items, now = new Date()) {
        if (typeof TodayHelp === 'undefined') return '';
        const events = items.filter(i => i.ev && !i.ev.allDay).map(i => ({ start: i.ev.start, end: i.ev.end || i.ev.start, title: i.title }));
        const tasks = items.filter(i => i.taskId).length;
        if (!events.length && !tasks) return '';
        return TodayHelp.daySummary(events, tasks, now);
    },



    _openTask(id) {
        if (typeof ThreadsPage !== 'undefined') ThreadsPage.open(`task:${id}`);
    },

    /**
     * COMING UP — the next seven days after today, as days (2026-10-05, when
     * the Calendar page left): timed and all-day events from the synced
     * calendars, dated tasks and their repeat occurrences, and an
     * appointment the calendar does not hold yet. Pure facts, nothing
     * model-written (W1); each row opens where the thing lives, like Today's.
     */
    comingUp(now = new Date(), days = 7) {
        const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        const byDay = new Map();
        const put = (date, row) => { if (!byDay.has(date)) byDay.set(date, []); byDay.get(date).push(row); };
        const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
        const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days, 23, 59, 59, 999);
        const dates = [];
        for (let i = 1; i <= days; i++) dates.push(iso(new Date(now.getFullYear(), now.getMonth(), now.getDate() + i)));
        if (!this.locked('calendar') && typeof CalendarApp !== 'undefined') {
            try {
                CalendarApp.loadData();
                const accounts = new Set(CalendarApp.getAccounts().map(a => a.email));
                for (const e of (CalendarApp.events || [])) {
                    if (e.status === 'cancelled' || e.source === 'schedule' || !(accounts.has(e.account) || e.source === 'apple')) continue;
                    if (!e.start || e.start < start || e.start > end) continue;
                    const open = e.source === 'apple'
                        ? (e.appleEventId ? { apple: e.appleEventId } : null)
                        : (e.htmlLink && /^https:\/\//i.test(e.htmlLink) ? { url: e.htmlLink } : null);
                    // The folder's page when the event has one (same rule as Today).
                    const mt = typeof Matters !== 'undefined' && Matters.forCalendarEvent ? Matters.forCalendarEvent(e.id) : null;
                    put(iso(e.start), { time: e.allDay ? '' : e.start.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
                        mins: e.allDay ? -1 : e.start.getHours() * 60 + e.start.getMinutes(), title: e.summary || 'Event', open: mt ? { matter: mt.id } : open, key: `event:${e.id}`, kind: 'event' });
                }
            } catch { /* calendar unavailable */ }
        }
        if (typeof Commitments !== 'undefined' && Commitments._inited) {
            try {
                for (const d of dates) {
                    for (const c of this._commitmentsOn_(d)) {
                        const at = this._clockRow(Commitments.timeOn(c, d).time);
                        put(d, { time: at.time, mins: at.mins, title: c.title, open: { task: c.id }, key: `task:${c.id}`, kind: 'task' });
                    }
                }
            } catch { /* commitments unavailable */ }
        }
        // A folder's step due on a day stands for that day (mail makes folders, not tasks).
        {
            for (const d of dates) {
                for (const { m, step } of this._stepsDueOn(d)) {
                    const at = this._clockRow(step.time);
                    put(d, { time: at.time, mins: at.mins, title: Matters.titleOf(m), open: { matter: m.id }, key: this._matterKey(m.id), kind: 'step' });
                }
            }
        }
        if (typeof Matters !== 'undefined' && !this.locked('fyi')) {
            try {
                for (const mt of Matters.upcoming(now.getTime())) {
                    if (mt.kind !== 'appointment' || mt.calendarEventId || !dates.includes(mt.when && mt.when.date)) continue;
                    const t = Matters._hm(mt.when.time);
                    put(mt.when.date, { time: t === null ? '' : new Date(2000, 0, 1, Math.floor(t / 60), t % 60).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
                        mins: t === null ? Infinity : t, title: Matters.titleOf(mt), open: { matter: mt.id }, key: this._matterKey(mt.id), kind: 'appointment' });
                }
            } catch { /* matters unavailable */ }
        }
        const out = [];
        for (const d of dates) {
            let rows = byDay.get(d);
            if (!rows || !rows.length) continue;
            rows = this._oneOfEach(rows).sort((a, b) => a.mins - b.mins);
            const dt = new Date(`${d}T12:00:00`);
            const label = dt.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
            out.push({ date: d, label, rows });
        }
        return out;
    },

    /**
     * COMING UP as a week strip (2026-10-07, Ram: the list was noisy and the
     * sentence that replaced it read as a paragraph). Joined by code from
     * `comingUp`'s facts, W1: the ONE next thing (title + when), then the
     * seven days as a strip, a dot per thing (four at most).
     * Every day is a door: tapping it shows that day's rows under the strip
     * ("Nothing on Friday." for a quiet one: a faded, dead day read as broken),
     * tapping it again folds them, and the fold resets on every visit to the
     * page (ThreadsPage.open) — a day shown is a look, never a state. Indexes
     * point into the flat list `schedule()` returns as `flat`.
     */
    comingWeek(coming, now = new Date(), days = 7) {
        const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        const byDate = new Map((coming || []).map(d => [d.date, d]));
        const out = [];
        let index = 0, total = 0, next = null;
        for (let i = 1; i <= days; i++) {
            const dt = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
            const date = iso(dt);
            const rows = byDate.get(date)?.rows || [];
            if (rows.length && !next) {
                const r = rows[0];
                const day = i === 1 ? 'Tomorrow' : dt.toLocaleDateString([], { weekday: 'long' });
                next = { index, title: r.title, when: r.time ? `${day} · ${r.time}` : day };
            }
            out.push({ date, dow: i === 1 ? 'Tmrw' : dt.toLocaleDateString([], { weekday: 'short' }), num: dt.getDate(), count: rows.length, first: index });
            index += rows.length;
            total += rows.length;
        }
        return { next, days: out, total };
    },

    /**
     * A row of the day (Today or Coming up), opened where it lives (2026-10-11,
     * Ram: "all the interactions with agent happens in threads page"): a task
     * or a folder opens its THREAD; a meeting opens in the calendar it came from.
     */
    openScheduleRow(row) { this._openRow(row); },
    _openRow(item) {
        if (!item?.open) return;
        const thread = item.open.task ? `task:${item.open.task}` : item.open.matter || null;
        if (thread && typeof ThreadsPage !== 'undefined') { ThreadsPage.open(thread); return; }
        if (item.open.task) { this._openTask(item.open.task); return; }
        if (item.open.matter) { this._openMatterPage(item.open.matter); return; }
        if (item.open.url) AppManager.openExternal(item.open.url);
        else if (item.open.apple) window.electronAuth?.openAppleCalendarEvent?.(item.open.apple);
    },

    agoLabel(ms, now = new Date()) {
        const mins = Math.floor((now.getTime() - ms) / 60000);
        if (mins < 1) return 'just now';
        if (mins < 60) return `${mins} min ago`;
        const h = Math.floor(mins / 60);
        return h < 24 ? `${h} hr ago` : new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric' });
    },

    /** The calendar's (and the task list's) turn in the status line
     *  (2026-10-05): the first sync, then MatterSources' own look. Email's
     *  read speaks first; nothing from a locked app. */
    _calendarStatus() {
        try {
            if (!this.locked('calendar') && typeof CalendarApp !== 'undefined' && CalendarApp.isSyncing && !(CalendarApp.events || []).length) return 'Getting your calendar…';
            const doing = typeof MatterSources !== 'undefined' ? MatterSources.doing : null;
            if (doing === 'calendar' && !this.locked('calendar')) return 'Reading your calendar…';
            if (doing === 'commitment' && !this.locked('actions') && !this.locked('schedule')) return 'Reading your tasks…';
        } catch { /* optional */ }
        return '';
    },

    // ── The cards (2026-10-01, Now's walk-through; in their threads since M7) ──
    //
    // Ram: nenva is a life coach / organizer / assistant that walks you
    // through things instead of throwing every email, task and event at
    // you. A card is ONE thing in nenva's voice, with what it recommends and
    // one main action, plus Later. Now showed them one at a time; since
    // docs/SENDERS.md M7 each card is the newest bubble of its thread (a
    // homeless one in nenva's), and the Now page itself left 2026-10-11.
    // Laws for the cards:
    //   W1 Every card comes from the app's own records (attention, overdue
    //      tasks, folders from mail, the next meeting, finished jobs, routine posts,
    //      connect/fix offers). Nothing here is model-written; Proactive's
    //      prepared meeting line is shown as it was stored.
    //   W2 Four kinds, so a card says why it is here: decide (waiting on
    //      you), offer (nenva prepared it / can do it), heads-up (worth
    //      knowing), check-in (coaching; step 2, none yet).
    //   W3 Order is code's: decide first (requests for judgment, then
    //      overdue, then folders with a step), then an imminent
    //      meeting, offers, then heads-ups.
    //   W4 Later hides a card for LATER_MS on this Mac; Got it settles a
    //      heads-up for good. Neither touches the record itself.
    LATER_MS: 4 * 60 * 60 * 1000,

    KIND_LABEL: { approval: 'Needs your approval', decide: 'Needs you', offer: 'I can do this', headsup: 'Heads-up', checkin: 'Check-in', question: 'A quick question' },

    /** The next timed meeting today that starts within two hours (or began
     *  in the last ten minutes) — the one worth a heads-up. */
    _imminentMeeting(now = new Date()) {
        if (this.locked('calendar') || typeof CalendarApp === 'undefined') return null;
        try {
            CalendarApp.loadData();
            const accounts = new Set(CalendarApp.getAccounts().map(a => a.email));
            const t = now.getTime();
            const ev = (CalendarApp.events || []).filter(e => e.status !== 'cancelled' && e.source !== 'schedule' && !e.allDay
                && (accounts.has(e.account) || e.source === 'apple') && e.start
                && e.start.getTime() <= t + 2 * 3600000 && e.start.getTime() >= t - 10 * 60000)
                .sort((x, y) => x.start - y.start)[0];
            if (!ev) return null;
            const open = ev.source === 'apple'
                ? (ev.appleEventId ? { apple: ev.appleEventId } : null)
                : (ev.htmlLink && /^https:\/\//i.test(ev.htmlLink) ? { url: ev.htmlLink } : null);
            const prep = typeof Proactive !== 'undefined' && Proactive.prepLineFor ? Proactive.prepLineFor(ev) : null;
            return { ev, open, prep };
        } catch { return null; }
    },

    /** Every card, in order (W1–W3), before Later/seen filtering. */
    allCards(now = new Date()) {
        const cards = [];
        const fmtDay = (iso) => {
            const d = iso ? new Date(iso + 'T00:00:00') : null;
            return d && !isNaN(d) ? d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' }) : '';
        };
        for (const r of this.nextRows()) {
            const key = `${r.kind}:${r.id}`;
            if (r.kind === 'ask') {
                const item = this.attention().find(a => a.id === r.id) || {};
                const offer = item.kind === 'followup';
                // A chat waiting on the person's approval (a permission ask
                // or a paused run) leads, and says so plainly (2026-10-01).
                const approval = item.kind === 'permission' || item.kind === 'continue';
                cards.push({ key, kind: offer ? 'offer' : approval ? 'approval' : 'decide', rank: approval ? 5 : offer ? 30 : 10,
                    title: r.title, body: r.detail,
                    primary: approval ? 'Review and approve' : (r.action || 'Review'), dismiss: r.dismiss || '', row: r,
                    // A follow-up lands in the thread of the folder holding its email thread, else nenva's (docs/SENDERS.md M6b).
                    ...(item.kind === 'followup' ? { followup: r.id, followThing: typeof Proactive !== 'undefined' && Proactive.thingOf ? Proactive.thingOf(r.id) : null, lookAt: Date.parse(item.revision || '') || 0 } : {}),
                    facts: { id: r.id, rev: item.revision || null, kind: item.kind || null },
                    talk: approval ? '' : `Help me with this: "${r.title}". ${r.detail || ''}` });
            } else if (r.kind === 'task') {
                // A work session the assistant arranged is a step of something,
                // never a card of its own (2026-10-04: "too much going on").
                if (this._commitmentsOn()) { const cc = Commitments.get(r.id); if (cc && cc.origin && cc.origin.kind === 'plan') continue; }
                // The assistant's read of it (Commitments, phase 4): its sentence
                // and its one offer lead; Mark done stays as a choice.
                if (r.missedDay) {
                    // A repeat's past day nothing was said about: a fact and two answers.
                    cards.push({ key, kind: 'decide', rank: 20, title: r.title, body: `${r.detail}. Did you do it?`,
                        primary: 'Mark done', choices: ['Skipped'], missed: r.missedDay, row: r,
                        facts: { id: r.id, missed: r.missedDay },
                        talk: `My repeating task "${r.title}" was due ${r.missedDay} and I never marked it. Help me decide what to do.` });
                    continue;
                }
                const cm = this._commitmentRead(r.id);
                const offer = cm && cm.read.offer ? CommitmentsPage.offerLabel(cm.read.offer, Commitments.today()) : null;
                cards.push({ key, kind: 'decide', rank: 20, title: r.title,
                    body: cm && cm.read.why ? cm.read.why : `${r.detail}. Do it today, move it, or let it go?`,
                    primary: offer || 'Mark done', ...(offer ? { cmOffer: r.id, ...(cm.read.offer.kind === 'done' ? {} : { choices: ['Mark done'] }) } : {}), row: r,
                    facts: { id: r.id, due: r.due || null, offer: cm && cm.read.offer ? [cm.read.offer.kind, cm.read.offer.date || null] : null, why: cm && cm.read.why || null },
                    talk: `My task "${r.title}" is overdue (${r.detail.toLowerCase()}). Help me decide: do it today, move it, or drop it?` });
            } else if (r.kind === 'connect' || r.kind === 'fix') {
                cards.push({ key, kind: 'offer', rank: 50, title: r.title, body: r.detail, primary: r.action, row: r, facts: { id: r.id }, talk: '' });
            }
        }
        // An appointment with an open step (docs/MATTERS.md): ONE card for the
        // appointment, whatever number of texts and emails asked.
        if (typeof Matters !== 'undefined' && !this.locked('fyi')) {
            Matters.reconcileSoon(now.getTime());
            const soon = now.getTime() + 14 * 86400000;
            // A trip a week out or under way (js/core/trips.js): the
            // assistant's brief and its first offer; the work an offer
            // started, once it has.
            if (typeof Trips !== 'undefined' && !this.locked('email')) {
                const weekOut = new Date(now.getTime() + 7 * 86400000).toISOString().slice(0, 10);
                for (const t of Trips.all()) {
                    if (t.start > weekOut) continue;
                    const rv = t.review, offer = rv && rv.offers && rv.offers[0];
                    const work = this._todayWork(`trip:${t.key}`, now.getTime());
                    cards.push({ key: `trip:${t.key}`, kind: 'offer', rank: 9, title: Trips.label(t),
                        body: work ? `${(rv && rv.brief) || Trips.fallbackBrief(t)} ${work.line}` : (rv && rv.brief) || Trips.fallbackBrief(t),
                        primary: work && work.action ? work.action.label : offer ? offer.label : 'See the trip',
                        trip: t.key, tripWork: work && work.action, tripAsk: !work && offer ? offer.ask : null,
                        // A trip speaks for its bookings (R1).
                        also: (t.bookings || []).map(b => this._matterKey(b.id)),
                        facts: { key: t.key, start: t.start, bookings: (t.bookings || []).map(b => b.id), brief: rv && rv.brief || null, offer: offer && offer.label || null },
                        talk: `Help me with my trip to ${t.name}.` });
                }
            }
            // A flight's check-in window (Matters.checkinFor): computed, so a
            // schedule change moves it.
            for (const mt of Matters.all()) {
                const ci = Matters.checkinFor(mt, now.getTime());
                if (!ci) continue;
                cards.push({ key: `checkin:${mt.id}`, kind: 'decide', rank: 11, title: `${Matters.titleOf(mt)} · ${Matters.whenText(mt)}`,
                    body: 'Check-in is open.', primary: 'Check in', dismiss: 'Checked in', checkinFor: mt.id, checkinUrl: ci.url,
                    facts: { id: mt.id, when: mt.when, checkin: true }, talk: '' });
            }
            // A booking on a trip speaks through the trip's card (its facts
            // carry the deadline, and the assistant offers it).
            let onTrip = new Set();
            try { if (typeof Trips !== 'undefined') onTrip = new Set(Trips.all().flatMap(t => t.bookings.map(b => b.id))); } catch { /* none */ }
            // Of two folders that look like one thing, one card (Matters.heldBack).
            const held = Matters.heldBack ? Matters.heldBack(now.getTime()) : new Set();
            for (const mt of Matters.openMatters(now.getTime())) {
                if (onTrip.has(mt.id) || held.has(mt.id)) continue;
                if (typeof SlackConnector !== 'undefined' && SlackConnector.routineOwns(mt)) continue;
                const step = Matters.openStep(mt);
                if (!step) continue;
                // The step's own date (or the thing's) within two weeks; an
                // undated step (a pickup, a problem) shows now.
                const by = step.by || (mt.when && mt.when.date);
                if (by && Date.parse(`${by}T12:00:00`) > soon) continue;
                const c = Matters.card(mt);
                if (!c) continue;
                cards.push({ key: `matter:${mt.id}:${step.id}`, kind: 'decide', rank: 12,
                    title: c.title, body: c.body, primary: c.primary, dismiss: c.dismiss, matter: mt.id, step: step.id,
                    // The folder speaks for its step's task and its messages (R1).
                    also: [step.taskId ? `task:${step.taskId}` : null, ...Matters.messagesOf(mt).map(x => `insight:${x.id}`)].filter(Boolean),
                    facts: { id: mt.id, status: mt.status || '', state: mt.state, when: mt.when || null, step: [step.what, step.by || null, step.how], messages: Matters.messagesOf(mt).map(x => x.id) },
                    whatsNew: this._matterNews(mt),
                    talk: `Help me with "${Matters.titleOf(mt)}"${mt.status ? ` (${mt.status})` : ''}: ${step.what}` });
            }
        }
        const m = this._imminentMeeting(now);
        if (m) {
            const mins = Math.round((m.ev.start.getTime() - now.getTime()) / 60000);
            const when = mins > 1 ? `Starts in ${mins} minutes.` : mins >= -1 ? 'Starting now.' : 'Started a few minutes ago.';
            const time = m.ev.start.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
            // The same help Today shows for it (TodayHelp): Join a call link,
            // Directions to a place, and the last email with the people.
            const help = this._eventHelp(m.ev, now) || {};
            const joinable = help.action && help.action.kind === 'url';
            const said = m.prep || help.line || '';
            cards.push({ key: `meet:${m.ev.id || m.ev.summary}:${m.ev.start.toISOString()}`, kind: 'headsup', rank: 15,
                title: `${m.ev.summary || 'Meeting'} at ${time}`, body: said ? `${when} ${said}` : when,
                primary: joinable ? help.action.label : m.open ? (m.open.apple ? 'Open in Calendar' : 'Open in Google Calendar') : '',
                url: joinable ? help.action.url : null, meeting: m,
                thing: `event:${m.ev.id || m.ev.summary}:${m.ev.start.toISOString()}`, facts: { id: m.ev.id || m.ev.summary, start: m.ev.start.toISOString() },
                talk: `Help me prepare for my meeting "${m.ev.summary || 'Meeting'}" at ${time}.` });
        }
        const dayAgo = Date.now() - 86400000;
        for (const t of this.jobs().filter(t => !this.jobStatus(t).live && new Date(t.updatedAt || t.createdAt || 0) > dayAgo)) {
            const st = this.jobStatus(t);
            const failed = st.label === 'Failed' || st.label === 'Stopped';
            cards.push({ key: `job:${t.id}:${t.status}`, kind: 'headsup', rank: failed ? 45 : 55,
                title: failed ? `${this.jobTitle(t)} didn’t finish` : `Finished: ${this.jobTitle(t)}`,
                body: t.note || (failed ? 'Want me to try again, or look at what happened?' : 'The report is in the chat.'),
                primary: 'Open', job: t.id, thing: `job:${t.id}`, facts: { id: t.id, status: t.status }, talk: '' });
        }
        for (const u of this.routineUpdates()) {
            // A look's report is ONE card per routine (docs/ROUTINES_UX.md I6):
            // its headline and before → after lines, only when the look said it
            // earns one; a card set aside comes back with the next change.
            if (u.look) {
                const c = u.look.card && typeof RoutineLook !== 'undefined' ? RoutineLook.cardOf(u.look) : null;
                if (c) cards.push({ key: `post:${u.id}`, kind: 'headsup', rank: 30, title: c.title, body: c.body || u.title,
                    primary: 'Read', post: u.id, routineId: u.promptId, thing: u.promptId ? `routine:${u.promptId}` : `post:${u.id}`,
                    facts: { routine: u.promptId, changes: u.look.changes || [], headline: u.look.headline },
                    whatsNew: c.title, talk: '' });
                continue;
            }
            cards.push({ key: `post:${u.id}`, kind: 'headsup', rank: u.error ? 48 : 58,
                title: u.title, body: u.summary || '',
                primary: 'Read', post: u.id, routineOf: u.promptId || null, facts: { id: u.id }, talk: '' });
        }
        // Failures are quiet (I7): one card per routine that keeps failing,
        // and one for all of them when the model is the cause.
        if (typeof RoutineFailures !== 'undefined' && typeof RoutineEngine !== 'undefined' && RoutineEngine.failures && !this.locked('prompts')) {
            try {
                const titleOf = id => { const r = typeof NotePrompts !== 'undefined' ? NotePrompts.list().find(x => x.id === id) : null; return r ? (r.title || 'A routine') : null; };
                for (const f of RoutineFailures.cards(RoutineEngine.failures(), titleOf, now.getTime())) {
                    cards.push({ key: f.thing, kind: f.kind, rank: 40, title: f.title, body: f.body, primary: f.primary,
                        thing: f.thing, facts: f.facts, talk: '', ...(f.model ? { modelFail: true } : { routineFail: f.routineId, routineId: f.routineId }) });
                }
            } catch (e) { console.warn('[now] routine failures failed:', e && e.message); }
        }
        // Work planned back from a due date (WorkPlans): the proposal, and a
        // replan when a session passed undone.
        if (typeof WorkPlans !== 'undefined' && !this.locked('actions') && !this.locked('schedule')) {
            try {
                // Two plans at a time, the nearest due first: a deck of plans
                // is a chore list, not help.
                for (const p of WorkPlans.proposals().sort((a, b) => a.due.localeCompare(b.due)).slice(0, 2)) {
                    const ss = p.plan.sessions;
                    const why = p.plan.why ? p.plan.why.charAt(0).toUpperCase() + p.plan.why.slice(1).replace(/\.?$/, '. ') : '';
                    cards.push({ key: `plan:${p.taskId}`, kind: 'offer', rank: 22, title: `${p.title} is due ${fmtDay(p.due)}`,
                        body: `${why}I'd do it in ${ss.length === 1 ? 'one session' : `${ss.length} sessions`}: ${ss.map(x => WorkPlans._label(x.date, x.time)).join(' · ')}. Each session says what to do.`,
                        // Says exactly what the tap does (2026-10-02: "Plan it" did not).
                        // Other times are the card's box: the task's own chat sees the plan (2026-10-08).
                        primary: ss.length === 1 ? 'Schedule 1 session' : `Schedule ${ss.length} sessions`, dismiss: 'Not needed', planFor: p.taskId,
                        thing: `plan:${p.taskId}`, facts: { id: p.taskId, due: p.due, sessions: ss.map(x => [x.date, x.time]) } });
                }
                const st = WorkPlans._state();
                const today = WorkPlans._iso(now);
                for (const m of WorkPlans.missed(st, WorkPlans._tasks(), now.getTime())) {
                    if ((st.byTask[m.taskId] || {}).missedAck === today) continue;
                    cards.push({ key: `replan:${m.taskId}`, kind: 'decide', rank: 21, title: `A work session for ${m.title} was missed`,
                        body: `It's due ${fmtDay(m.due)}. Want me to plan the rest again around your days?`, primary: 'Replan', dismiss: 'Leave it', replanFor: m.taskId,
                        thing: `replan:${m.taskId}`, facts: { id: m.taskId, due: m.due, missed: m.missed || today } });
                }
            } catch (e) { console.warn('[now] work plans failed:', e && e.message); }
        }
        // A bigger goal the assistant reads as stuck or slipping, with its
        // offer (Commitments phase 4): at most two, the goal's own chat behind.
        if (this._commitmentsOn()) {
            try {
                const all = Commitments.all();
                const today = Commitments.today();
                const goals = all.filter(c => c.state === 'open' && !c.parent && Commitments.shapeOf(c) === 'goal')
                    .map(c => ({ c, r: Commitments.shownRead(c, all, today) }))
                    .filter(x => x.r && x.r.offer && (x.r.stance === 'stuck' || x.r.stance === 'slipping')).slice(0, 2);
                for (const { c, r } of goals) cards.push({ key: `commitment:${c.id}`, kind: 'offer', rank: 32, title: c.title,
                    body: r.why || '', primary: CommitmentsPage.offerLabel(r.offer, today), commitment: c.id,
                    facts: { id: c.id, stance: r.stance, offer: r.offer ? [r.offer.kind, r.offer.date || null] : null, why: r.why || null } });
            } catch (e) { console.warn('[now] commitments failed:', e && e.message); }
        }
        // A preference asked with taps, never a settings screen (PrefAsks,
        // docs/AI_NATIVE.md phase 4): one at a time, after what needs a decision.
        if (typeof PrefAsks !== 'undefined') {
            try {
                for (const q of PrefAsks.due(now.getTime())) {
                    cards.push({ key: `pref:${q.id}`, kind: 'question', rank: 40, title: q.question, body: q.why || '',
                        primary: q.choices[0].label, choices: q.choices.slice(1).map(c => c.label), pref: q.id, prefValues: q.choices.map(c => c.value),
                        facts: { id: q.id } });
                }
            } catch (e) { console.warn('[now] preference asks failed:', e && e.message); }
        }
        // "How did it go?" after something planned for today (js/core/ask-after.js):
        // one at a time, gone the moment anything is reported on that day.
        if (typeof AskAfter !== 'undefined' && this._commitmentsOn() && !this.locked('actions') && !this.locked('schedule')) {
            try { for (const c of AskAfter.cards(now.getTime())) cards.push({ ...c, thing: c.key, facts: { id: c.askAfter.id, day: c.askAfter.day } }); } catch (e) { console.warn('[now] ask-after failed:', e && e.message); }
        }
        // Check-ins (step 2, js/core/check-ins.js): coaching questions, ranked
        // below anything that needs a decision. Their own budget and memory
        // of answers live in CheckIns; Now only shows today's picks.
        if (typeof CheckIns !== 'undefined') {
            try {
                for (const c of CheckIns.today(now)) {
                    cards.push({ key: `checkin:${c.subject}`, kind: 'checkin', rank: 52, title: c.title, body: c.body,
                        primary: c.offer, checkin: c.subject, ...(CheckIns.thingOf(c) ? { checkinThing: CheckIns.thingOf(c) } : {}), lookAt: ((CheckIns.state().subjects || {})[c.subject] || {}).askedAt || 0, facts: { subject: c.subject, day: c.day || null }, talk: c.prompt || '' });
                }
            } catch (e) { console.warn('[now] check-ins failed:', e && e.message); }
        }
        // The money coach (js/core/money-coach.js, docs/MONEY_COACH.md): today's
        // picks from the money sheet.
        if (typeof MoneyCoach !== 'undefined') {
            try {
                for (const c of MoneyCoach.today(now)) {
                    cards.push({ key: `money:${c.subject}`, kind: 'checkin', rank: 51, title: c.title, body: c.body,
                        primary: c.offer, coach: c.subject, ...(c.item ? { moneyItem: c.item } : {}), lookAt: MoneyCoach.state().lookedAt || 0, facts: { subject: c.subject, offer: c.offer }, talk: c.prompt || '' });
                }
            } catch (e) { console.warn('[now] money coach failed:', e && e.message); }
        }
        // The coach for fitness, health, parenting and learning goals
        // (js/core/coach.js, docs/COACH.md §5): what the money coach left of
        // the shared budget (CO7). Its offer opens the goal's own chat; a
        // health concern's words are code's (CO6).
        if (typeof Coach !== 'undefined') {
            try {
                const room = Coach.CARDS_MAX - cards.filter(c => c.coach).length;
                for (const c of Coach.today(now, room)) {
                    cards.push({ key: `coach:${c.subject}`, kind: 'checkin', rank: c.concern ? 40 : 51, title: c.title, body: c.body,
                        primary: c.offer, coachGoal: c.goal, coachSubject: c.subject, concern: !!c.concern, lookAt: ((Coach.state().domains || {})[c.domain] || {}).lookedAt || 0,
                        facts: { subject: c.subject, offer: c.offer }, talk: c.prompt || '' });
                }
            } catch (e) { console.warn('[now] coach failed:', e && e.message); }
            // What nenva can coach, one card per area, until the person has a
            // goal there or answers it (Coach.intros). After everything real.
            try {
                for (const c of Coach.introCards(now)) {
                    cards.push({ key: `coach:${c.subject}`, kind: 'offer', rank: 55, intro: true, title: c.title, body: c.body,
                        primary: c.offer, coachSubject: c.subject, facts: { subject: c.subject }, talk: c.prompt });
                }
            } catch (e) { console.warn('[now] coach intros failed:', e && e.message); }
        }
        // Each sender's own look (js/core/sender-look.js, docs/SENDERS.md M6):
        // one card per thing, shown in its thread (and here until M7).
        if (typeof SenderLook !== 'undefined') {
            try {
                for (const c of SenderLook.cards(now)) {
                    // The raise's other one-tap answers ride as choices (G1); each sends its own words in the thread.
                    cards.push({ key: `look:${c.sender}`, kind: 'checkin', rank: 52, title: c.title, body: c.body, primary: c.offer,
                        choices: (c.answers || []).map(a => a.label), lookAnswers: c.answers || [],
                        senderLook: c.sender, lookAt: c.at, facts: { subject: c.subject, offer: c.offer, answers: (c.answers || []).map(a => a.label) }, talk: c.prompt || '' });
                }
            } catch (e) { console.warn('[now] sender looks failed:', e && e.message); }
        }
        // A card a chat was started from says what that chat is doing and
        // opens it, instead of repeating its first offer (2026-10-02,
        // reported: a plan card kept offering after the chat had handled it).
        for (const c of cards) {
            if (c.kind === 'approval' || c.trip || c.pref) continue;
            const w = this._todayWork(this.thingKey(c), now.getTime()) || this._todayWork(c.key, now.getTime());
            // A chat shows IN the card (its thread); only a job the chat
            // started changes what the card says and its button.
            if (!w || !w.action || w.action.kind !== 'job') continue;
            c.body = `${c.body ? `${c.body} ` : ''}${w.line}`;
            c.work = w.action;
            c.primary = w.action.label;
            c.choices = [];
        }
        // Every card is a raise about a THING (docs/NOW.md R1): its thing
        // key, the facts its rev is hashed from (never its words, which may
        // carry "in 2 days"), and the things it speaks for.
        const folderCards = new Set(cards.filter(c => c.matter).map(c => this._matterKey(c.matter)));
        for (const c of cards) {
            if (!c.thing) c.thing = this.thingKey(c);
            // An overdue task made from a folder's step speaks for the
            // folder when the folder itself has no card (its step is done);
            // while the folder has one, the folder speaks for the task.
            if (c.row && c.row.kind === 'task' && c.row.matter && !c.also && !folderCards.has(this._matterKey(c.row.matter))) c.also = [this._matterKey(c.row.matter)];
            if (!c.rev) c.rev = typeof Raises !== 'undefined' ? Raises.rev(c.facts || { kind: c.kind, title: c.title, primary: c.primary }) : '';
        }
        return this._gentle(cards.sort((a, b) => a.rank - b.rank), now);
    },

    // ── A new install is introduced gently (2026-10-11, by request) ─────
    //
    // Ram: on a new install Threads showed "a bunch of recommendations"
    // at once; introduce what nenva can do gradually instead. For the
    // first GENTLE_DAYS after setup (NEW_SINCE_KEY, written by setup, so
    // a Mac that was set up before this never counts as new), what nenva
    // OFFERS unasked (an introduction, a preference question, a check-in,
    // a coach's or a look's card, a work plan, a read on a goal) is held to
    // ONE a day, and none on the setup day itself. What the person's own
    // things need (approvals, overdue, a folder's step, Connect) is never
    // held. Each source keeps its own budget too; this is the ceiling.
    NEW_SINCE_KEY: 'nenva-new-since',
    GENTLE_KEY: 'now-gentle',
    GENTLE_DAYS: 7,
    _SUGGESTION: /^(coach|money|checkin|pref|look|plan|commitment):/,
    /** Is this card something nenva offers unasked? Pure. */
    isSuggestion(c) { return !!(c && this._SUGGESTION.test(String(c.key || '')) && c.kind !== 'approval' && !c.concern); },
    /**
     * The cards a new install shows today (pure). `st` = { since, day, key }:
     * the setup time and today's one suggestion, kept for the day so
     * answering it brings no other. Returns { cards, st } (st changed only
     * when today's pick was made).
     */
    gentle(cards, st, nowMs) {
        const since = Number(st && st.since) || 0;
        if (!since || nowMs - since >= this.GENTLE_DAYS * 86400000 || nowMs < since) return { cards, st };
        const iso = ms => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
        const day = iso(nowMs);
        if (iso(since) === day) return { cards: cards.filter(c => !this.isSuggestion(c)), st };
        let key = st.day === day ? st.key : null;
        let next = st;
        if (!key) {
            const first = cards.slice().sort((a, b) => (a.rank || 0) - (b.rank || 0)).find(c => this.isSuggestion(c));
            if (first) { key = first.key; next = { ...st, day, key }; }
        }
        return { cards: cards.filter(c => !this.isSuggestion(c) || c.key === key), st: next };
    },
    _gentle(cards, now = new Date()) {
        let st = null;
        try {
            const since = Number(localStorage.getItem(this.NEW_SINCE_KEY)) || 0;
            if (!since) return cards;
            st = { ...(JSON.parse(localStorage.getItem(this.GENTLE_KEY) || 'null') || {}), since };
        } catch { return cards; }
        const r = this.gentle(cards, st, now.getTime());
        if (r.st !== st) { try { localStorage.setItem(this.GENTLE_KEY, JSON.stringify({ day: r.st.day, key: r.st.key })); } catch { /* per-Mac */ } }
        return r.cards;
    },

    /** What arrived on a folder since the person set its card aside (R3's reason), or null. */
    _matterNews(mt) {
        if (typeof Raises === 'undefined' || typeof Matters === 'undefined') return null;
        const r = Raises.get(this._matterKey(mt.id));
        const since = r && r.settled && r.settled.by !== 'record' ? Date.parse(r.settled.at) : r && r.state === 'later' ? Date.parse((r.history || []).at(-1)?.at || 0) : 0;
        if (!since) return null;
        const fresh = Matters.messagesOf(mt).filter(x => Date.parse(x.filedAt || x.at || 0) > since).pop();
        if (!fresh) return null;
        const when = new Date(fresh.at || fresh.filedAt).toLocaleDateString([], { month: 'short', day: 'numeric' });
        return `${fresh.kind === 'imessage' ? 'A text' : 'An email'} from ${fresh.from || 'them'} on ${when}.`;
    },

    // ── A card's conversation (2026-10-02, by request) ──────────────────
    //
    // Each THING has one chat (thingKey). The card carries where the thing
    // stands after it (cardStandingHtml: one line, the latest change with
    // Undo, the chat's door), and the box in the card is the door to it: a
    // click opens the chat page with the cursor in its composer
    // (openCardChat). The transcript itself left the card 2026-10-07.
    /**
     * The THING a card is about, which its chat is tied to: one
     * conversation per item, task, trip or event, wherever it is reached
     * from (Now's card, Today's row, a plan) (2026-10-02, by request).
     */
    thingKey(card) {
        if (!card) return null;
        if (card.commitment) return `task:${card.commitment}`;
        if (card.coachGoal) return `task:${card.coachGoal}`;
        if (card.senderLook) return card.senderLook;
        if (card.moneyItem) return card.moneyItem;
        if (card.checkinThing) return card.checkinThing;
        if (card.followThing) return card.followThing;
        if (card.matter || card.checkinFor) return this._matterKey(card.matter || card.checkinFor);
        if (card.trip) return `trip:${card.trip}`;
        if (card.routineId) return `routine:${card.routineId}`;
        if (card.planFor || card.replanFor) return `task:${card.planFor || card.replanFor}`;
        if (card.meeting && card.meeting.ev) return `event:${card.meeting.ev.id}`;
        const r = card.row;
        if (r && r.kind === 'task') return `task:${r.id}`;
        return card.key;
    },
    /** An item's key: its id already reads "matter:…". */
    _matterKey(id) { return String(id).startsWith('matter:') ? String(id) : `matter:${id}`; },
    /** The thing's chat, newest first; chats tied to the card's old key still count. */
    _thingConv(card) {
        const thing = this.thingKey(card);
        // A folder joined into this one had its own chat: it is this thing's chat too.
        const joined = thing && thing.startsWith('matter:') && typeof Matters !== 'undefined' && Matters.aliasesOf ? Matters.aliasesOf(thing) : [];
        const keys = new Set([thing, card.key, card.planFor ? `plan:${card.planFor}` : null,
            thing && thing.startsWith('matter:') ? `matter:${thing}` : null, ...joined].filter(Boolean));
        return (AgentService.conversations || []).filter(c => keys.has(c.todayKey))
            .sort((a, b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0))[0] || null;
    },
    _cardConv(card) {
        let conv = this._thingConv(card);
        if (conv) return { conv, fresh: false };
        conv = { id: 'conv_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6), title: String(card.title || 'From Now').slice(0, 60),
            createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), messages: [], todayKey: this.thingKey(card) };
        AgentService.conversations.unshift(conv);
        AgentService._saveConversations();
        return { conv, fresh: true };
    },
    _plain(md) {
        return String(md || '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/[*_`#>]+/g, '').replace(/\s+/g, ' ').trim();
    },
    /**
     * The card's box is the door to the thing's own chat (2026-10-02, by
     * request: "take the user seamlessly to the chatbox in that chat page").
     * A thing without a chat gets one that opens with a note of what it is
     * about (code-written, from the card), so neither the person nor the
     * assistant starts from nothing. The composer is focused on arrival.
     */
    openCardChat(key) {
        const card = this._cardByKey(key);
        // "How did it go?": its chat opens with the question asked in it.
        if (card && card.askAfter && typeof AskAfter !== 'undefined') { AskAfter.open(card.askAfter.id, card.askAfter.day); return; }
        // A routine's chat is its Standing chat, opened at the run (I6).
        if (card && card.post && typeof PromptFeed !== 'undefined') { PromptFeed.openPost(card.post, { back: 'Threads' }); return; }
        if (card && card.routineFail && this.openStanding) { this.openStanding(card.routineFail); return; }
        if (card) this.openChatFor(card);
    },
    /**
     * Open a thing's own chat with the cursor in its composer. `card` is a
     * Now card, or any page's stand-in ({ key, title, body, row: { kind, id } }),
     * e.g. the Commitments sheet's box (2026-10-03).
     */
    openChatFor(card) {
        if (!card || typeof AgentService === 'undefined') return;
        const { conv, fresh } = this._cardConv(card);
        if (fresh) {
            const body = String(card.body || '').trim();
            conv.messages.push({ role: 'assistant', content: `This chat is about “${card.title}”.${body ? ` ${/[.!?]$/.test(body) ? body : body + '.'}` : ''} What would you like to do with it?`,
                timestamp: new Date().toISOString(), metadata: { fromCard: true } });
            conv.updatedAt = new Date().toISOString();
            AgentService._saveConversations();
        }
        // The chat rises over the page as a bottom sheet (2026-10-09, by
        // request), the same drawer every other hand-off opens.
        if (typeof PageChat !== 'undefined' && PageChat.openConversation) { PageChat.openConversation(conv, card.title, () => this.render(), this.thingKey(card)); return; }
        this.resume(conv.id);
        const focus = (n = 0) => {
            // The chat page's composer (the side panel's is #agent-input).
            const input = [document.getElementById('agent-app-input'), document.getElementById('agent-input')].find(el => el && el.offsetParent !== null);
            if (input) { input.focus(); return; }
            if (n < 20) setTimeout(() => focus(n + 1), 50);
        };
        focus();
    },

    /**
     * While the mailbox is being read, what it finds WAITS (2026-10-05,
     * reported on a first run: "cards are coming and going on its own").
     * Each message is read, then filed, then maybe folded into a folder or
     * settled by a later one, so a card shown mid-read appeared, changed
     * into another and left again by itself. A raise from mail or texts is
     * CREATED held while the queue is busy and opens when it empties
     * (Raises.reconcile: held → open); one already open stays open. A queue
     * that has not moved for READ_STALL_MS stops holding, so a stuck read
     * can never hide anything for good.
     */
    READ_STALL_MS: 90000,
    _mailHold() {
        const email = this.emailHome();
        let hold = !!(email?.reading && !email.blocked);
        if (hold) {
            const mark = `${email.loading ? 'l' : ''}${email.queued}`;
            if (!this._readMark || this._readMark.mark !== mark) this._readMark = { mark, at: Date.now() };
            if (Date.now() - this._readMark.at > this.READ_STALL_MS) hold = false;
        } else this._readMark = null;
        return hold;
    },
    _fromMail(c) { return !!(c.matter || c.checkinFor || c.trip); },

    /**
     * What this shell would raise now (docs/NOW.md): every card, as a raise
     * about its thing. Registered once as the `now` raiser; Raises keeps the
     * records, this only produces.
     */
    produce(now = new Date()) {
        const all = this.allCards(now instanceof Date ? now : new Date(now));
        this._live = new Map();
        const hold = this._mailHold();
        const out = [];
        for (const c of all) {
            if (this._live.has(c.thing)) continue;
            this._live.set(c.thing, c);
            out.push({ thing: c.thing, rev: c.rev, also: c.also || [], held: hold && this._fromMail(c), whatsNew: c.whatsNew || null,
                content: { kind: c.kind, title: c.title, body: c.body || '', primary: c.primary || '', choices: c.choices || [], dismiss: c.dismiss || '', source: this.sourceOf(c) || '' } });
        }
        return out;
    },
    _registerRaiser() {
        if (this._raiserOn || typeof Raises === 'undefined') return;
        this._raiserOn = true;
        Raises.register('now', { raise: (now) => this.produce(new Date(now)) });
    },

    /**
     * The cards on Now: the OPEN raises, each joined with the live card its
     * producer built this tick (the record holds the state and the words; the
     * live card holds what the buttons need). Nothing here reads a per-Mac
     * side-table any more: Later and Got it are settlements on the record.
     */
    cards(now = new Date()) {
        if (typeof Raises === 'undefined') return this.allCards(now);
        this._registerRaiser();
        const t = now.getTime();
        const open = Raises.refresh(t);
        this._heldCount = Raises.all().filter(r => r.state === 'held').length;
        const live = this._live || new Map();
        return open.map(r => { const c = live.get(r.thing); return c ? { ...c, raise: r, reopened: r.reopened || null } : null; }).filter(Boolean);
    },

    /** The person set a card aside (a tap, or their words in its chat): the settlement on the record. */
    _settle(card, how, opts = {}) {
        if (typeof Raises === 'undefined' || !card || !card.thing) return;
        Raises.settleThing(card.thing, how, { by: opts.by || 'you', quote: opts.quote || null, until: how === 'later' ? this.LATER_MS : null });
    },

    _cardByKey(key) {
        return this.cards().find(c => c.key === key) || this.allCards().find(c => c.key === key);
    },

    /** Commitments are the truth and the page exists (flag on, bridge started). */
    // ── Commitments as Now reads them (2026-10-11: the old task blob is no
    // longer read here) ────────────────────────────────────────────────
    /** Open commitments that happen on `day` and are not done or dropped that day. */
    _commitmentsOn_(day) {
        if (typeof Commitments === 'undefined' || !Commitments._inited) return [];
        return Commitments.all().filter(c => c && c.title && c.state === 'open'
            && !(c.privacySources || []).includes('slack')
            && (Commitments.repeats(c) ? Commitments.occursOn(c, day) : !!(c.when && c.when.date === day))
            && !Commitments.isDone(c, day) && !(c.history && c.history[day] === 'dropped'));
    },
    _iso(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; },
    /** A clock "HH:MM" as the person reads it, with minutes from midnight. */
    _clockRow(hm) {
        const m = /^(\d{1,2}):(\d{2})$/.exec(String(hm || ''));
        return m ? { time: new Date(2000, 0, 1, +m[1], +m[2]).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }), mins: +m[1] * 60 + +m[2] } : { time: '', mins: Infinity };
    },
    /** Folders whose open step is due on `day` (mail makes folders, not tasks). */
    _stepsDueOn(day) {
        if (typeof Matters === 'undefined' || this.locked('fyi')) return [];
        try {
            return (Matters.forAmbient ? Matters.forAmbient() : Matters.all()).filter(m => m && m.state === 'open')
                .map(m => ({ m, step: Matters.openStep(m) })).filter(x => x.step && x.step.by === day);
        } catch { return []; }
    },
    _commitmentsOn() { return typeof Commitments !== 'undefined' && !!Commitments._inited && typeof CommitmentsPage !== 'undefined'; },
    /** The assistant's read of a task, when there is one worth showing. */
    _commitmentRead(id) {
        if (!this._commitmentsOn()) return null;
        const c = Commitments.get(id);
        if (!c) return null;
        const read = Commitments.shownRead(c, Commitments.all(), Commitments.today());
        return read ? { c, read } : null;
    },

    /**
     * Which of a card's own quiet buttons "let it go" means (2026-10-03).
     * For good: the button that ends it (Ignore on an item, the card's own
     * dismiss such as a follow-up's Not now, Don't ask on a check-in), else
     * marking it seen. For now: Show later / Not now. Pure; null when the
     * card cannot be set aside (an approval waits on the person).
     */
    letGoAct(card, forGood) {
        if (!card || card.kind === 'approval') return null;
        if (!forGood) return 'later';
        if (card.matter) return 'ignore';
        if (card.checkin || card.coach || card.askAfter) return 'stop';
        if (card.pref) return 'later';
        if (card.dismiss || card.planFor || card.replanFor || card.checkinFor) return 'dismiss';
        return 'gotit';
    },

    /**
     * The card a chat is about, set aside as the person asked IN that chat
     * (2026-10-03: "just ignore it" got "Dropped." and the card stayed,
     * because nothing in the chat could reach the card). Runs the card's own
     * button through cardAct, so the chat and the card do the same thing.
     */
    /** The card on Now a chat's todayKey is about, or null when it is not there (any more). */
    cardForThing(thing) {
        if (!thing) return null;
        // The chat of a folder that was joined into another is about that one now.
        if (String(thing).startsWith('matter:') && typeof Matters !== 'undefined') { const m = Matters.get(thing); if (m) thing = m.id; }
        return this.allCards().find(c => c.key === thing || this.thingKey(c) === thing) || null;
    },

    letGoFromChat(thing, forGood, { quote = null } = {}) {
        if (!thing) return { error: 'This chat is not about a card on Now.' };
        const card = this.cardForThing(thing);
        if (!card) return { done: true, note: 'It is no longer on Now; nothing to set aside.' };
        const act = this.letGoAct(card, forGood);
        if (!act) return { error: 'This card is waiting for the person to approve something; it cannot be set aside from here.' };
        this.cardAct(card.key, act, { by: 'chat', quote });
        return { done: true, title: card.title, how: forGood ? 'for good' : 'for now' };
    },

    /**
     * A card's button. The record-side effect first (the folder, the
     * commitment, the check-in's own memory…), then the settlement on the
     * raise (docs/NOW.md R2), stamped with who did it: a tap (`you`) or the
     * person's words in the card's chat (`chat`, with the quote).
     */
    cardAct(key, act, who = {}) {
        const card = this._cardByKey(key);
        if (!card) return;
        const settle = (how) => this._settle(card, how, who);
        // "How did it go?" (AskAfter): a tap marks that day, the main button
        // opens the commitment's chat with the question asked in it.
        if (card.askAfter && typeof AskAfter !== 'undefined') {
            const a = card.askAfter;
            if (act === 'primary' || act === 'talk') { AskAfter.open(a.id, a.day); return; }
            if (act === 'choice:1' || act === 'choice:2') { AskAfter.mark(a.id, a.day, act === 'choice:1' ? 'done' : 'dropped'); settle('answered'); this.render(); return; }
            if (act === 'stop') { AskAfter.stop(a.id); settle('stop'); this.render(); return; }
            if (act === 'later') { settle('later'); this.render(); return; }
            if (act === 'open' && typeof CommitmentsPage !== 'undefined') { CommitmentsPage.open(a.id); return; }
        }
        // A card tied to a chat or a job opens it (see the end of allCards).
        if (card.commitment && typeof CommitmentsPage !== 'undefined') {
            const c = Commitments.get(card.commitment);
            if (act === 'primary' && c) { CommitmentsPage.takeOffer(c); settle('answered'); this.render(); return; }
            if (act === 'open') { CommitmentsPage.open(card.commitment); return; }
        }
        if (card.work && act === 'primary') {
            if (card.work.kind === 'job') this.openJob(card.work.id); else if (card.work.kind === 'conv') this.resume(card.work.id);
            return;
        }
        // A work plan (WorkPlans): Schedule N sessions adds them; nothing before.
        if (card.planFor && typeof WorkPlans !== 'undefined') {
            if (act === 'primary') {
                const n = WorkPlans.accept(card.planFor);
                if (n && typeof UIUtils !== 'undefined') UIUtils.showToast(`Added ${n} work session${n === 1 ? '' : 's'} to your tasks`, 'success');
                settle('answered'); this.render(); return;
            }
            if (act === 'choice:1' || act === 'talk') { WorkPlans.talk(card.planFor); return; }
            if (act === 'dismiss') { WorkPlans.decline(card.planFor); settle('ignore'); this.render(); return; }
            if (act === 'open') { this._openTask(card.planFor); return; }
        }
        if (card.replanFor && typeof WorkPlans !== 'undefined') {
            if (act === 'primary') { WorkPlans.replan(card.replanFor); settle('answered'); this.render(); return; }
            if (act === 'dismiss') { const st = WorkPlans._state(); if (st.byTask[card.replanFor]) { st.byTask[card.replanFor].missedAck = WorkPlans._iso(new Date()); WorkPlans._save(st); } settle('ignore'); this.render(); return; }
            if (act === 'open') { this._openTask(card.replanFor); return; }
        }
        // A preference question: a tap writes the answer to Memory (PrefAsks).
        if (card.pref && typeof PrefAsks !== 'undefined') {
            if (act === 'later') { PrefAsks.snooze(card.pref); settle('later'); this.render(); return; }
            const i = act === 'primary' ? 0 : /^choice:\d+$/.test(act) ? Number(act.slice(7)) : -1;
            if (i >= 0) { PrefAsks.answer(card.pref, card.prefValues[i]); settle('answered'); this.render(); return; }
            if (act === 'open') return;
        }
        // A check-in's answers are CheckIns' to remember (C4): Not now waits
        // a week, Don't ask stops it, the offer counts as accepted.
        if (card.checkin && typeof CheckIns !== 'undefined') {
            if (act === 'later') { CheckIns.respond(card.checkin, 'notnow'); settle('later'); this.render(); return; }
            if (act === 'stop') { CheckIns.respond(card.checkin, 'stop'); settle('stop'); this.render(); return; }
            if (act === 'primary') { CheckIns.accept(card.checkin); settle('answered'); this.render(); return; }
            if (act === 'open') return;
        }
        // The money coach keeps its own answers too (docs/MONEY_COACH.md MC6).
        if (card.coach && typeof MoneyCoach !== 'undefined') {
            if (act === 'later') { MoneyCoach.respond(card.coach, 'notnow'); settle('later'); this.render(); return; }
            if (act === 'stop') { MoneyCoach.respond(card.coach, 'stop'); settle('stop'); this.render(); return; }
            if (act === 'primary' || act === 'talk') { MoneyCoach.accept(card.coach); settle('answered'); this.render(); return; }
            if (act === 'open') return;
        }
        // The goal coach keeps its own answers (CO8); the offer and the title
        // open the goal (its chat, its sheet).
        if (card.coachSubject && typeof Coach !== 'undefined') {
            if (act === 'later') { Coach.respond(card.coachSubject, 'notnow'); settle('later'); this.render(); return; }
            if (act === 'stop') { Coach.respond(card.coachSubject, 'stop'); settle('stop'); this.render(); return; }
            if (act === 'primary' || act === 'talk' || (act === 'open' && card.intro)) {
                if (card.concern) Coach.respond(card.coachSubject, 'gotit'); else Coach.accept(card.coachSubject);
                settle('answered'); this.render(); return;
            }
            if (act === 'open') { if (typeof CommitmentsPage !== 'undefined') CommitmentsPage.open(card.coachGoal); return; }
        }
        // A sender's look keeps its own answers (SenderLook L4); the offer is sent in its thread.
        if (card.senderLook && typeof SenderLook !== 'undefined') {
            if (act === 'later') { SenderLook.respond(card.senderLook, 'notnow'); settle('later'); this.render(); return; }
            if (act === 'stop') { SenderLook.respond(card.senderLook, 'stop'); settle('stop'); this.render(); return; }
            if (act === 'primary' || act === 'talk') { SenderLook.accept(card.senderLook); settle('answered'); this.render(); return; }
            const choice = /^choice:(\d+)$/.exec(act);
            if (choice) { const r = SenderLook.accept(card.senderLook, Number(choice[1])); settle(r && r.later ? 'later' : 'answered'); this.render(); return; }
            if (act === 'open') { SenderLook.openThread(card.senderLook); return; }
        }
        // Later is a state on the record with an until (R2), never a per-Mac table.
        if (act === 'later') { settle('later'); this.render(); return; }
        // Not useful on a folder card (§17): the feedback on its newest
        // message (it teaches what to skip from that sender), then the folder
        // is let go, with Undo, like Ignore.
        if (act === 'notuseful' && card.matter && typeof Matters !== 'undefined') {
            const m = Matters.get(card.matter);
            const last = m ? Matters.messagesOf(m).pop() : null;
            if (last && typeof EmailApp !== 'undefined' && EmailApp.recordInsightFeedback) EmailApp.recordInsightFeedback(last.id, false);
            // The feedback's own toast says what was learned (as on an insight row).
            if (m) Matters.ignore(m.id);
            settle('ignore'); this.render();
            return;
        }
        // Got it on a heads-up, or "ignore" on a card whose record has no
        // door for it (an overdue task's chat): settled on the raise, which
        // holds while the facts hold and comes back with the reason when
        // they move (R3). The record itself is untouched.
        if (act === 'gotit') { settle(who.by === 'chat' ? 'ignore' : 'done'); this.render(); return; }
        if (act === 'talk') {
            // A trip's chat is tied to the trip, with its facts in view.
            if (card.trip && typeof Trips !== 'undefined') { Trips.ask(card.trip); return; }
            // Tied to the card (todayKey), so the card can say what the chat is doing.
            if (card.talk && typeof AgentUI !== 'undefined' && AgentUI.askWithPrompt) AgentUI.askWithPrompt(card.talk, { newChat: true, todayKey: this.thingKey(card) });
            return;
        }
        // The title opens the thing's own page; the main button does the
        // action (Ram, 2026-10-01: "take the user to the insight detail page").
        // A folder's page is the matter page (2026-10-07, by request: the
        // title used to land on the newest message, or in Gmail); the
        // source is a row there, never the first tap.
        if (act === 'open' && (card.trip || card.matter || card.checkinFor)) {
            if (card.trip && typeof FyiPage !== 'undefined') { FyiPage.openTrip(card.trip); return; }
            if (this._openMatterPage(card.matter || card.checkinFor)) return;
        }
        if (card.trip && typeof Trips !== 'undefined') {
            if (act === 'primary' || act === 'open') {
                const w = card.tripWork;
                if (w && w.kind === 'job') this.openJob(w.id);
                else if (w && w.kind === 'conv') this.resume(w.id);
                else if (card.tripAsk) Trips.ask(card.trip, card.tripAsk);
                else if (typeof FyiPage !== 'undefined') FyiPage.openTrip(card.trip);
                return;
            }
        }
        if (card.checkinFor && typeof Matters !== 'undefined') {
            if (act === 'dismiss') { Matters.markCheckedIn(card.checkinFor); settle('done'); this.render(); return; }
            if (act === 'primary' || act === 'open') {
                const m = Matters.get(card.checkinFor);
                if (card.checkinUrl) AppManager.openExternal(card.checkinUrl);
                else if (m && typeof EmailApp !== 'undefined') EmailApp.openMessageFrom((Matters.messagesOf(m).pop() || {}).id);
                return;
            }
        }
        if (card.matter && typeof Matters !== 'undefined') {
            if (act === 'ignore') {
                const before = Matters.ignore(card.matter);
                settle('ignore');
                this.render();
                if (before && typeof UIUtils !== 'undefined') UIUtils.showToast(`Ignored: ${Matters.titleOf(Matters.get(card.matter))}`, 'success', 7000, {
                    actionLabel: 'Undo', onAction: () => { Matters.unignore(card.matter, before); this.render(); }
                });
                return;
            }
            if (act === 'dismiss') { Matters.markStep(card.matter, card.step); settle('done'); this.render(); return; }
            if (act === 'primary' || act === 'open') { Matters.openDraft(card.matter, card.step); return; }
        }
        if (act === 'dismiss' && card.row && typeof Proactive !== 'undefined') { Proactive.dismiss(card.row.id); settle('ignore'); this.render(); return; }
        // 'open' (the title) and 'primary' (the main button)
        if (card.cmOffer && typeof CommitmentsPage !== 'undefined') {
            if (act === 'primary') { CommitmentsPage.takeOffer(Commitments.get(card.cmOffer)); settle('answered'); this.render(); return; }
            if (act === 'choice:1') { this.nextAct(key, true); return; }
        }
        if (card.missed && card.row && (act === 'primary' || act === 'choice:1')) { settle('answered'); this._markMissed(card.row, act === 'primary' ? 'done' : 'dropped'); return; }
        if (card.row) { this.nextAct(key, act === 'primary'); return; }
        if (card.meeting) {
            if (act === 'primary' && card.url) { AppManager.openExternal(card.url); return; }
            if (card.meeting.open?.url) AppManager.openExternal(card.meeting.open.url);
            else if (card.meeting.open?.apple) window.electronAuth?.openAppleCalendarEvent?.(card.meeting.open.apple);
            return;
        }
        if (card.job) { settle('done'); this.openJob(card.job); return; }
        if (card.post && typeof PromptFeed !== 'undefined') { PromptFeed.openPost(card.post, { back: 'Threads' }); this.render(); }
        // A routine that keeps failing: its page holds Last problem and Run now.
        if (card.routineFail) { AppManager.openApp('prompts'); if (AppManager.currentApp === 'prompts' && typeof PromptsApp !== 'undefined') PromptsApp.open({ id: card.routineFail }); return; }
        if (card.modelFail && typeof SimpleSettings !== 'undefined') { SimpleSettings.open('model'); return; }
    },

    /**
     * A card's buttons, in order: the one list Now draws and the phone
     * (PhoneReach, Telegram) offers, so the two never differ. Pure.
     */
    cardActs(card) {
        if (!card) return [];
        const acts = [];
        if (card.primary) acts.push({ act: 'primary', label: card.primary });
        (card.choices || []).forEach((label, i) => acts.push({ act: `choice:${i + 1}`, label }));
        if (card.kind === 'headsup') acts.push({ act: 'gotit', label: 'Got it' });
        if (card.kind !== 'approval') acts.push(card.dismiss ? { act: 'dismiss', label: card.dismiss } : { act: 'later', label: card.kind === 'checkin' || card.intro ? 'Not now' : 'Show later' });
        if (card.kind === 'checkin' || card.intro) acts.push({ act: 'stop', label: 'Don’t ask about this' });
        if (card.matter) acts.push({ act: 'ignore', label: 'Ignore' });
        // Feedback, not an action, so it sits apart at the right (2026-10-02,
        // by request). Teaches what to skip (EmailApp.recordInsightFeedback:
        // the example guides the next read from this sender; twice for one
        // sender and kind writes a Memory › Email fact). On a folder card too (§17).
        if (this._fedByMessages(card)) acts.push({ act: 'notuseful', label: 'Not useful', feedback: true });
        return acts;
    },

    /**
     * How a card's button runs when it is pressed on the phone (Telegram,
     * 2026-10-09), where no page or chat can open on the Mac:
     *   do   cardAct runs exactly as on the Mac (it changes a record and opens nothing);
     *   url  the button is a link the phone opens itself;
     *   ask  the press is the person asking, in the Telegram chat, for what
     *        the Mac's button would have opened a chat about (`text`);
     *   say  nenva asks a question in the Telegram chat (`text`);
     *   none the act needs the Mac; the phone shows no button for it.
     * Read-only.
     */
    phonePlan(card, act) {
        if (!card || !act) return { how: 'none' };
        if (act !== 'primary' && !/^choice:/.test(act)) return { how: 'do' }; // later, gotit, dismiss, stop, ignore, notuseful
        const talk = card.talk ? { how: 'ask', text: card.talk } : { how: 'none' };
        if (card.askAfter && typeof AskAfter !== 'undefined') {
            if (act !== 'primary') return { how: 'do' };
            const c = typeof Commitments !== 'undefined' ? Commitments.get(card.askAfter.id) : null;
            return c ? { how: 'say', text: AskAfter.question({ c, day: card.askAfter.day }) } : { how: 'none' };
        }
        const offerOf = (id) => {
            const c = typeof Commitments !== 'undefined' ? Commitments.get(id) : null;
            const o = c && c.read && c.read.offer;
            if (!o) return { how: 'none' };
            if (/^(move|done|drop)$/.test(o.kind)) return { how: 'do' };
            return typeof CommitmentsPage !== 'undefined' ? { how: 'ask', text: CommitmentsPage.offerPrompt(o, c) } : { how: 'none' };
        };
        if (card.commitment && act === 'primary') return offerOf(card.commitment);
        if (card.work) return act === 'primary' ? { how: 'none' } : { how: 'do' };
        if (card.planFor) {
            if (act === 'primary') return { how: 'do' };
            return { how: 'ask', text: `Help me plan the work for "${card.title}". Suggest times that suit me, and ask before adding anything to my tasks.` };
        }
        if (card.replanFor || card.pref || card.missed) return { how: 'do' };
        if (card.checkin && typeof CheckIns !== 'undefined') {
            const c = (CheckIns.state().cards || []).find(x => x.subject === card.checkin);
            return c && c.kind !== 'memory' && c.prompt ? { how: 'ask', text: c.prompt } : { how: 'none' };
        }
        if (card.coach) return card.talk ? { how: 'ask', text: card.talk } : { how: 'none' };
        if (card.coachSubject) return card.concern ? { how: 'do' } : talk;
        if (card.senderLook) {
            const ch = /^choice:(\d+)$/.exec(act);
            const ans = ch ? (card.lookAnswers || [])[Number(ch[1]) - 1] : null;
            if (ans) return ans.laterDays ? { how: 'do' } : { how: 'ask', text: ans.ask };
            return card.talk ? { how: 'ask', text: card.talk } : talk;
        }
        if (card.trip) return card.tripAsk && typeof Trips !== 'undefined' && Trips.get(card.trip)
            ? { how: 'ask', text: `${card.tripAsk}\n\nMy trip, from my bookings:\n${Trips.factsText(Trips.get(card.trip))}` } : talk;
        if (card.checkinFor) return card.checkinUrl ? { how: 'url', url: card.checkinUrl } : { how: 'none' };
        if (card.matter && typeof Matters !== 'undefined') {
            const m = Matters.get(card.matter), st = m && Matters.openStep(m);
            if (!st) return { how: 'none' };
            if (st.how === 'link') return st.url ? { how: 'url', url: st.url } : { how: 'none' };
            if (st.how === 'none') return { how: 'do' };
            // Their own sentence rides along (2026-10-12: a turn read the folder, not the text that held the two times offered, and said the text did not spell them out).
            if (st.how === 'reply') return { how: 'ask', text: `Draft my reply for "${Matters.titleOf(m)}"${st.quote ? ` to their message: "${String(st.quote).slice(0, 240)}"` : ''}${st.reply ? `, starting from: "${st.reply}"` : ''}. Show it to me here and send it only once I approve.` };
            return talk;
        }
        if (card.cmOffer) return act === 'primary' ? offerOf(card.cmOffer) : { how: 'do' };
        if (card.row) {
            const row = this.nextRows().find(r => `${r.kind}:${r.id}` === card.key);
            return row && row.kind === 'task' ? { how: 'do' } : { how: 'none' };
        }
        if (card.meeting) return card.url ? { how: 'url', url: card.url } : card.meeting.open && card.meeting.open.url ? { how: 'url', url: card.meeting.open.url } : { how: 'none' };
        return { how: 'none' };
    },

    /**
     * A card's button pressed on the phone: runs it as phonePlan says and
     * returns what happened ({ done }, { ask, text }, { say, text }, or
     * { gone } when the card is no longer on Now). An ask also does what
     * the Mac's button does besides opening the chat (the coach and the
     * check-in remember the yes; the card is answered), so the deck agrees.
     */
    phoneCardAct(key, act) {
        const card = this.cards().find(c => c.key === key);
        if (!card) return { gone: true };
        const plan = this.phonePlan(card, act);
        if (plan.how === 'do') { this.cardAct(key, act, { by: 'you' }); return { done: true }; }
        if (plan.how === 'say') return { say: true, text: plan.text };
        if (plan.how !== 'ask') return { none: true };
        if (card.checkin && typeof CheckIns !== 'undefined') CheckIns.respond(card.checkin, 'accept');
        else if (card.coach && typeof MoneyCoach !== 'undefined') MoneyCoach.respond(card.coach, 'accept');
        else if (card.coachSubject && typeof Coach !== 'undefined') Coach.respond(card.coachSubject, 'accept');
        else if (card.senderLook && typeof SenderLook !== 'undefined') SenderLook.respond(card.senderLook, 'accept');
        if (card.checkin || card.coach || card.coachSubject || card.senderLook || card.commitment || card.cmOffer) { this._settle(card, 'answered', { by: 'you' }); this.render(); }
        return { ask: true, text: plan.text };
    },

    // Where a card came from, shown as a small monochrome icon on it
    // (2026-10-02, by request: "visibly show some icons to show … which
    // source"). Stroked SVG, one per source; the name is the tooltip.
    SOURCE_ICON: {
        email: { label: 'From email', svg: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>' },
        text: { label: 'From a text message', svg: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.4A8 8 0 1 1 21 12Z"/>' },
        calendar: { label: 'From your calendar', svg: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/>' },
        tasks: { label: 'From your tasks', svg: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="m8.5 12 2.5 2.5 4.5-5"/>' },
        projects: { label: 'From your projects', svg: '<path d="M5 21V4"/><path d="M5 4h11l-2 4 2 4H5"/>' },
        routine: { label: 'From a routine', svg: '<path d="M17 2l3 3-3 3"/><path d="M4 11V9a4 4 0 0 1 4-4h16"/><path d="M7 22l-3-3 3-3"/><path d="M20 13v2a4 4 0 0 1-4 4H4"/>' },
        assistant: { label: 'From the assistant', svg: '<path d="M12 3l1.9 5.6L19.5 10.5l-5.6 1.9L12 18l-1.9-5.6L4.5 10.5l5.6-1.9z"/>' },
        nenva: { label: 'From nenva', svg: '<circle cx="12" cy="12" r="8.5"/><path d="M12 8v5"/><path d="M12 16h.01"/>' }
    },
    sourceOf(card) {
        if (!card) return 'nenva';
        if (card.pref || card.coach) return 'nenva';
        if (card.askAfter) return 'tasks';
        if (card.checkin) {
            const k = String(card.checkin).split(':')[0];
            return k === 'project' ? 'projects' : (k === 'habit' || k === 'lingering') ? 'tasks' : 'nenva';
        }
        const msgKind = (ids) => {
            const kinds = new Set(ids.map(id => (typeof EmailApp !== 'undefined' && EmailApp.emailById ? (EmailApp.emailById(id) || {}).source : null) === 'imessage' ? 'text' : 'email'));
            return kinds.has('email') ? 'email' : 'text';
        };
        if (card.matter || card.checkinFor) {
            const m = typeof Matters !== 'undefined' ? Matters.get(card.matter || card.checkinFor) : null;
            const msgs = m ? Matters.messagesOf(m) : [];
            return msgs.length && msgs.every(x => x.kind === 'imessage') ? 'text' : 'email';
        }
        if (card.trip) return 'email';
        if (card.planFor || card.replanFor) return 'tasks';
        if (card.meeting) return 'calendar';
        if (card.job) return 'assistant';
        if (card.post) return 'routine';
        const r = card.row;
        if (r) {
            if (r.kind === 'task') return 'tasks';
            if (r.kind === 'ask') return card.kind === 'offer' ? 'email' : 'assistant';
        }
        return 'nenva';
    },
    /** A folder card whose folder holds at least one email or text (feedback has a sender to teach about). */
    _fedByMessages(card) {
        if (!card || !card.matter || typeof Matters === 'undefined') return false;
        const m = Matters.get(card.matter);
        return !!(m && Matters.messagesOf(m).length);
    },
    /** The folder's own page (js/apps/fyi/matter-page.js); false when the page is not loaded or the folder is gone. */
    _openMatterPage(matterId) {
        return typeof MatterPage !== 'undefined' && !!matterId && MatterPage.open(matterId);
    },

    /**
     * Repaint what is on screen (2026-10-11: Threads is the home page, so
     * this is the Threads page when it is up). Every record change that
     * used to repaint Now still calls this.
     */
    render() {
        if (!this.enabled) return;
        if (typeof ThreadsPage !== 'undefined' && ThreadsPage._repaint) ThreadsPage._repaint();
    },

    /**
     * The day as the home page shows it (2026-10-11, in nenva's thread):
     * Today's rows with their help lines, the day line, and the next seven
     * days as Coming up (a flat list the strip and the open day index into).
     * Facts only, nothing model-written but TodayHelp's one line per row.
     */
    schedule(now = new Date()) {
        const today = this.todayItems(now);
        const coming = this.comingUp(now);
        const flat = []; for (const day of coming) for (const r of day.rows) flat.push({ ...r, date: day.date, label: day.label });
        return { today, todayLine: this.todayLine(today, now), coming, flat, week: this.comingWeek(coming, now) };
    },

    /**
     * Open a routine's Standing chat (2026-10-07), at one of its runs when
     * `runId` is given: the chat page, scrolled to that message. Reading
     * is what opening is, so the chat's runs are marked read here.
     */
    openStanding(id, runId = null) {
        if (typeof NotePrompts === 'undefined' || !NotePrompts.conversationOf(id) || this.locked('agent')) return;
        NotePrompts.markRunsRead(id);
        this.resume(id, { standing: true });
        if (!runId) return;
        requestAnimationFrame(() => {
            const el = document.querySelector(`.agent-message[data-run="${CSS.escape(String(runId))}"]`);
            if (!el) return;
            el.classList.add('is-target');
            el.scrollIntoView({ block: 'start' });
        });
    },

    resume(id, { standing = false } = {}) {
        if (!(standing ? !!(typeof NotePrompts !== 'undefined' && NotePrompts.conversationOf(id)) : this.conversations().some(c => c.id === id))) return;
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

    mountHistory() {
        const page = document.createElement('main');
        page.id = 'conversations-view';
        page.className = 'view app-view simple-history';
        page.setAttribute('aria-labelledby', 'simple-history-title');
        page.innerHTML = `<div class="simple-history-content">
            <header class="simple-history-header"><h1 id="simple-history-title">Chats</h1></header>
            <div class="nv-chats-tabs" role="tablist" aria-label="Chats"></div>
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
            const tab = e.target.closest('[data-chats-tab]');
            if (tab) { this.showHistoryTab(tab.dataset.chatsTab); return; }
            const del = e.target.closest('[data-del-chat]');
            if (del) { e.stopPropagation(); this.deleteChat(del.dataset.delChat); return; }
            const row = e.target.closest('[data-simple="chat"]');
            if (row) this._historySelection = row.dataset.id;
        });
    },

    /**
     * Jobs (2026-10-01, nenva desktop's Jobs page): every task-mode run
     * the user can see, newest first. A run here posts its report into the
     * chat it came from, so a job OPENS that chat on its card (review());
     * a routine's run opens the routine. Private chats and a locked
     * assistant contribute nothing, like everywhere in this shell.
     */
    /** Every job: the team's (TeamJobs), then the retired task engine's records, read-only. */
    _allJobs() {
        return typeof TeamJobs !== 'undefined' ? TeamJobs.all() : [];
    },

    jobs() {
        const chats = new Set(this.conversations().map(c => c.id));
        const routinesOk = !this.locked('prompts');
        return this._allJobs().filter(t => t && t.id
            && ((t.conversationId && chats.has(t.conversationId)) || (!t.conversationId && t.routineId && routinesOk)))
            .sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0));
    },

    jobStatus(t) {
        if (['planning', 'running', 'verifying'].includes(t.status)) return { label: 'Working', live: true };
        if (t.status === 'awaiting_user') return { label: 'Needs you', live: true, attn: true };
        if (t.status === 'paused') return { label: 'Paused' };
        if (t.status === 'done') return { label: 'Done' };
        if (t.status === 'failed') return { label: /cancelled by the user/i.test(t.note || '') ? 'Stopped' : 'Failed' };
        return { label: '' };
    },

    jobTitle(t) {
        if (t.routineId) return this.routineTitle(t.routineId);
        const g = String(t.goal || 'A job').replace(/\s+/g, ' ').trim();
        return g.length > 80 ? g.slice(0, 80).replace(/\s+\S*$/, '') + '\u2026' : g;
    },

    jobWhen(t) {
        const d = new Date(t.updatedAt || t.createdAt || Date.now());
        const today = new Date();
        return d.toDateString() === today.toDateString()
            ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
            : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
    },

    /** A job opens its own view (its steps, Stop, Allow / Don't allow); the chat it belongs to is one click back. */
    openJob(id) {
        this._jobOpen = id;
        if (AppManager.currentApp !== 'jobs') AppManager.openAppFromLauncher('jobs');
        this.renderJobs();
    },
    /** The job of a chat, when one is live or recent (its status rides the chat's row). */
    jobOfChat(convId) {
        return this.jobs().find(t => t.conversationId === convId) || null;
    },

    /** The chat a job reports into, on its card; a routine run opens the routine. */
    openJobChat(id) {
        const t = this._allJobs().find(x => x && x.id === id);
        if (!t) return;
        if (!t.conversationId && t.routineId) {
            AppManager.openApp('prompts');
            if (AppManager.currentApp === 'prompts' && typeof PromptsApp !== 'undefined') PromptsApp.open({ id: t.routineId });
            return;
        }
        this.resume(t.conversationId);
        if (AppManager.currentApp !== 'agent') return;
        const card = document.querySelector(`[data-job-strip="${String(id).replace(/["\\]/g, '')}"]`);
        if (card) { card.tabIndex = -1; card.scrollIntoView({ block: 'center' }); card.focus({ preventScroll: true }); }
    },

    /** Job progress (TeamJobs._changed): repaint what shows it. */
    onTaskUpdate() {
        if (!this.enabled) return;
        clearTimeout(this._taskPaint);
        this._taskPaint = setTimeout(() => {
            if (AppManager.currentApp === 'jobs') this.renderJobs();
            else this.render();
        }, 150);
    },

    mountJobs() {
        const page = document.createElement('main');
        page.id = 'jobs-view';
        page.className = 'view app-view simple-history simple-jobs';
        page.setAttribute('aria-labelledby', 'simple-jobs-title');
        page.innerHTML = `<div class="simple-history-content">
            <h1 id="simple-jobs-title" hidden>Job</h1>
            <div class="simple-jobs-list"></div>
        </div>`;
        document.getElementById('app-views').append(page);
        page.addEventListener('click', e => {
            const del = e.target.closest('[data-del-job]');
            if (del) { e.stopPropagation(); this.deleteJob(del.dataset.delJob); return; }
            const row = e.target.closest('[data-job]');
            if (row) { this.openJob(row.dataset.job); return; }
            const act = e.target.closest('[data-job-act]')?.dataset.jobAct;
            // Back is the chat the job belongs to (or its routine): there is no
            // list of jobs (2026-10-06, Jobs folded into Chats).
            if (act === 'back' && this._jobOpen) { const id = this._jobOpen; this._jobOpen = null; this.openJobChat(id); }
            if (act === 'stop' && this._jobOpen) {
                if (typeof TeamJobs !== 'undefined' && TeamJobs.isJob(this._jobOpen)) TeamJobs.stop(this._jobOpen);
                this.renderJobs();
            }
            if (act === 'continue' && this._jobOpen && typeof TeamJobs !== 'undefined') TeamJobs.resume(this._jobOpen);
            if ((act === 'allow' || act === 'deny') && this._jobOpen && typeof TeamJobs !== 'undefined') { TeamJobs.answer(this._jobOpen, act === 'allow'); this.renderJobs(); }
            if (act === 'chat' && this._jobOpen) this.openJobChat(this._jobOpen);
        });
        AppManager.register('jobs', { render: () => this.renderJobs() });
    },

    /**
     * One job (nenva's job page): the way back, its status, Stop while it
     * runs, the title, what it ended on, its steps as a list, and the chat
     * it reports into, where the full report and follow-ups live. Every
     * word is the task's own record; nothing here is model-written.
     */
    jobDetail(t) {
        const esc = UIUtils.escapeHtml;
        const st = this.jobStatus(t);
        const mark = (s) => s.status === 'done' ? '\u2713' : s.status === 'failed' ? '\u2717'
            : s.status === 'skipped' ? '\u2013' : s.status === 'running' ? '' : '\u00b7';
        const steps = (t.plan || []).map(s => `<li class="nv-step is-${esc(s.status || 'pending')}">
                <span class="nv-step-mark">${s.status === 'running' ? '<span class="nv-ring" aria-hidden="true"></span>' : mark(s)}</span>
                <span class="nv-step-copy"><span>${esc(String(s.step || '').replace(/\s+/g, ' ').trim())}</span>${s.note ? `<small>${esc(s.note)}</small>` : ''}</span>
            </li>`).join('');
        const chatLabel = !t.conversationId && t.routineId ? 'Open the routine' : st.attn ? 'Review in chat' : 'Open the chat';
        const backLabel = !t.conversationId && t.routineId ? 'Routine' : 'Chat';
        // A routine run waiting on a change (TeamJobs J2): answered right here.
        const wait = typeof TeamJobs !== 'undefined' ? TeamJobs.waiting(t.id) : null;
        return `<div class="nv-job-head">
                <button type="button" class="nv-link" data-job-act="back">\u2039 ${esc(backLabel)}</button>
                <span class="nv-job-status${st.live ? ' is-live' : ''}${st.attn ? ' is-attn' : ''}">${esc(st.label)}</span>
                ${st.live && !st.attn ? '<button type="button" class="secondary-btn" data-job-act="stop">Stop</button>' : ''}
                ${t.engine === 'team' && (t.status === 'paused' || t.status === 'failed') ? '<button type="button" class="secondary-btn" data-job-act="continue">Continue</button>' : ''}
            </div>
            <h1 class="nv-job-h1">${esc(this.jobTitle(t))}</h1>
            ${t.note && !wait ? `<p class="nv-job-note">${esc(t.note)}</p>` : ''}
            ${steps ? `<ol class="nv-steps">${steps}</ol>` : ''}
            ${wait ? `<div class="nv-job-wait"><p>${esc(wait.def.label)} wants to: <strong>${esc(wait.text)}</strong></p>
                <button type="button" class="primary-btn" data-job-act="allow">Allow</button>
                <button type="button" class="secondary-btn" data-job-act="deny">Don&rsquo;t allow</button></div>` : ''}
            ${t.changes && t.changes.length && !st.live ? `<p class="nv-job-note">Changed: ${esc(t.changes.join('; '))}</p>` : ''}
            <div class="nv-job-actions"><button type="button" class="${st.attn && !wait ? 'primary-btn' : 'secondary-btn'}" data-job-act="chat">${esc(chatLabel)}</button></div>`;
    },

    /** The job view shows ONE job (2026-10-06): no list, since a job is its chat's. */
    renderJobs() {
        const host = document.querySelector('#jobs-view .simple-jobs-list');
        if (!host) return;
        const open = this._jobOpen ? this.jobs().find(t => t.id === this._jobOpen) : null;
        if (open) { host.innerHTML = this.jobDetail(open); return; }
        this._jobOpen = null;
        host.innerHTML = '<p class="simple-empty">This job is no longer here.</p>';
    },

    // ── Hover delete on the Chats and Jobs lists (2026-10-01) ──────────
    // A row is a button, so the trash icon is its SIBLING inside a wrapper
    // and shows on hover/focus. Deleting is immediate with Undo on the
    // toast, never a confirm dialog.
    deleteBtnHtml(kind, id) {
        const label = kind === 'chat' ? 'Delete chat' : 'Delete job';
        return `<button type="button" class="nv-del-btn" data-del-${kind}="${UIUtils.escapeHtml(id)}" title="${label}" aria-label="${label}"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/></svg></button>`;
    },

    deleteChat(id) {
        if (AgentService.isConversationStreaming(id)) {
            UIUtils.showToast('This chat is still answering. Stop it first.', 'error');
            return;
        }
        const conv = (AgentService.conversations || []).find(c => c.id === id);
        if (!conv) return;
        AgentService.deleteConversation(id);
        this.renderHistory();
        this.render?.();
        UIUtils.showToast('Chat deleted', 'success', 5000, {
            actionLabel: 'Undo',
            onAction: () => {
                if ((AgentService.conversations || []).some(c => c.id === id)) return;
                AgentService.conversations.unshift(conv);
                AgentService._saveConversations();
                this.renderHistory();
                this.render?.();
            }
        });
    },

    deleteJob(id) {
        // Final either way (no Undo): a team job is a room in main's log, and
        // an old task-engine record is read-only history.
        if (typeof TeamJobs === 'undefined') return;
        TeamJobs.remove(id).then(() => {
            if (this._jobOpen === id) this._jobOpen = null;
            this.renderHistory(); this.render?.();
            UIUtils.showToast('Job deleted', 'success');
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

    /**
     * Standing chats (2026-10-06): the person's routines, listed on Chats
     * with their trigger and last run. Every word is the routine's own
     * record (NotePrompts, RoutineEngine's status); nothing model-written.
     */
    standingRows() {
        if (typeof NotePrompts === 'undefined' || this.locked('prompts') || this.locked('agent')) return [];
        try {
            const status = id => (typeof RoutineEngine !== 'undefined' && RoutineEngine.statusFor) ? RoutineEngine.statusFor(id) : {};
            const ago = iso => iso && typeof PromptFeed !== 'undefined' && PromptFeed._timeAgo ? PromptFeed._timeAgo(iso) : '';
            // Every Standing chat: an armed routine, or a saved prompt that
            // runs when asked (moved out of Notes 2026-10-07; nothing is
            // dropped). Unread is the chat's: its newest run not yet opened.
            return NotePrompts.list().map(n => {
                const cfg = NotePrompts.config(n);
                const st = status(n.id);
                const job = this.jobs().find(t => t.routineId === n.id && this.jobStatus(t).live);
                const conv = NotePrompts.conversationOf(n.id);
                const unread = conv && NotePrompts.unreadRuns ? NotePrompts.unreadRuns(conv) : 0;
                // The sentence the person confirmed reads better than the trigger (I9).
                const said = cfg.offline && NotePrompts.sentence ? NotePrompts.sentence(cfg) : null;
                return { id: n.id, title: n.title || 'Untitled routine', when: said || (cfg.offline ? (cfg.watcher === 'mail' ? 'as your mail and texts arrive' : NotePrompts.triggerLabel(cfg)) : 'when you ask'),
                    last: job ? this.jobStatus(job).label : st.lastError ? 'Last run failed' : st.lastRun ? `ran ${ago(st.lastRun)}` : cfg.offline ? 'not run yet' : '',
                    attn: !!(job && this.jobStatus(job).attn), failed: !job && !!st.lastError, unread };
            }).sort((a, b) => (b.attn ? 1 : 0) - (a.attn ? 1 : 0) || a.title.localeCompare(b.title));
        } catch { return []; }
    },
    standingHtml(query, { bare = false } = {}) {
        const esc = UIUtils.escapeHtml;
        // The door is the list's quiet last line once there are routines
        // (the calm pass, 2026-10-07); the sentence explaining what a
        // routine is shows only while there are none.
        const all = this.standingRows();
        const rows = all.filter(r => `${r.title} ${r.when}`.toLowerCase().includes(query));
        if (!rows.length && query) return '';
        const setUp = `<button type="button" class="simple-row simple-history-row nv-standing-new${all.length ? ' is-quiet' : ''}" data-simple="routine-new">
                <span class="simple-history-copy"><span class="simple-history-title">Set up a routine</span>${all.length ? '' : '<span class="simple-history-preview">Something nenva does for you on its own, every day or whenever something arrives.</span>'}</span></button>`;
        return `<section class="simple-history-group nv-standing" aria-label="Standing">${bare ? '' : '<h2>Standing</h2>'}<div class="simple-sheet">${rows.map(r =>
            `<button type="button" class="simple-row simple-history-row${r.unread ? ' is-unread' : ''}" data-simple="routine" data-id="${esc(r.id)}">
                <span class="simple-history-copy"><span class="simple-history-title">${esc(r.title)}${r.unread ? '<span class="nv-standing-dot" title="New result" aria-label="New result"></span>' : ''}</span><span class="simple-history-preview">${esc(r.when)}</span></span>
                <span class="simple-row-meta${r.attn ? ' nv-job-status is-attn' : ''}${r.failed ? ' nv-standing-failed' : ''}">${esc(r.last)}</span>
            </button>`).join('')}${query ? '' : setUp}</div></section>`;
    },

    /* ── Conversations | Standing (2026-10-07, by request: "when chats
       grew, its hard to go to standing page"). Two tabs in Finance's
       shape (Investments | Spending) over the one Chats page: the search
       reads the tab you are on, each tab carries its count, and Standing
       wears a dot while a routine needs you or its last run failed, so a
       problem is never buried under the other tab. The tab is per-Mac
       (localStorage, a convenience); the routine page's way back lands on
       Standing (PromptsApp.toChats). ── */
    HISTORY_TAB_KEY: 'chats-tab',

    historyTab() {
        if (this._historyTab) return this._historyTab;
        let t = null;
        try { t = localStorage.getItem(this.HISTORY_TAB_KEY); } catch { /* private window */ }
        return (this._historyTab = t === 'standing' ? 'standing' : 'chats');
    },

    showHistoryTab(tab) {
        this._historyTab = tab === 'standing' ? 'standing' : 'chats';
        try { localStorage.setItem(this.HISTORY_TAB_KEY, this._historyTab); } catch { /* private window */ }
        this._historyScroll = 0;
        const page = this._historyPage;
        if (page) {
            page.querySelector('input').value = '';
            this.renderHistory();
            page.scrollTop = 0;
        }
    },

    /** A row's time: relative within the week, then a date ("Sep 25";
     *  the year only when it is not this one). */
    historyWhen(iso) {
        const t = Date.parse(iso);
        if (!t) return '';
        if (Date.now() - t < 7 * 86400e3) return AgentUI.formatTimeAgo(iso);
        const d = new Date(t);
        return d.toLocaleDateString('en-US', d.getFullYear() === new Date().getFullYear()
            ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
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
        // A chat's job speaks on its row (2026-10-06, Jobs folded into Chats):
        // Working / Needs you in place of the time while it is live.
        const jobBy = new Map(this.jobs().filter(t => t.conversationId).map(t => [t.conversationId, this.jobStatus(t)]));
        const rows = allowed.map(c => ({ ...c, preview: this.historyPreview(byId.get(c.id)), job: jobBy.get(c.id) || null }))
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
            groups.push(`<div class="nv-del-wrap"><button type="button" class="simple-row simple-history-row" data-simple="chat" data-id="${esc(c.id)}">
                <span class="simple-history-copy"><span class="simple-history-title">${esc(c.title || 'Untitled')}</span>${c.preview ? `<span class="simple-history-preview">${esc(c.preview)}</span>` : ''}</span>
                <span class="simple-row-meta${c.job && c.job.attn ? ' nv-job-status is-attn' : ''}">${esc(c.job && c.job.live ? c.job.label : AgentService.isConversationStreaming(c.id) ? 'Working' : this.historyWhen(c.updatedAt))}</span>
            </button>${this.deleteBtnHtml('chat', c.id)}</div>`);
        }
        if (bucket) groups.push('</div></section>');
        const tab = this.historyTab();
        const standingAll = this.standingRows();
        const tabs = page.querySelector('.nv-chats-tabs');
        if (tabs) {
            const attn = standingAll.some(r => r.attn || r.failed);
            const word = (id, label, n, dot) => `<button type="button" role="tab" class="nv-chats-tab${tab === id ? ' is-active' : ''}" data-chats-tab="${id}" aria-selected="${tab === id}">${label}${n ? `<span class="nv-chats-tab-n">${n}</span>` : ''}${dot ? '<span class="nv-chats-tab-dot" title="A routine needs you"></span>' : ''}</button>`;
            tabs.innerHTML = word('chats', 'Conversations', allowed.length, false) + word('standing', 'Standing', standingAll.length, attn);
        }
        const input = page.querySelector('input');
        const ph = tab === 'standing' ? 'Search routines…' : 'Search conversations…';
        if (input.placeholder !== ph) { input.placeholder = ph; input.setAttribute('aria-label', ph.replace('…', '')); }
        const list = page.querySelector('.simple-history-list');
        if (tab === 'standing') {
            list.innerHTML = this.standingHtml(query, { bare: true })
                || `<p class="simple-empty">No routines match your search.</p>`;
        } else {
            list.innerHTML = groups.length ? groups.join('')
                : `<p class="simple-empty">${this.locked('agent') ? 'Unlock your conversations to see your history.' : query ? 'No conversations match your search.' : 'Your saved conversations will appear here.'}</p>`;
        }
        page.scrollTop = scroll;
    }
};
