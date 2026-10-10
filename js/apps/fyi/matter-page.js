/**
 * The matter page (2026-10-07, by request): one tracked thing from your
 * mail and texts — the dentist on Thursday, the water bill, the cake order —
 * on a sheet of its own, in the commitment sheet's design language.
 *
 * Before this, a Now card's title opened the Insights page on the newest
 * MESSAGE about the thing (one email card, "Open in Gmail" as its main
 * button, the folder stapled on underneath), or Gmail itself when that
 * message had no analysis on this Mac. The person's unit is the matter,
 * not the message, so the page is the folder: what it is and where it
 * stands, nenva's next step with its real action, every message filed on
 * it (each with its own door to Gmail or Messages), the calendar event it
 * is, the tasks about it, what happened, and the box.
 *
 * Laws:
 *   MP1  The facts are READ-ONLY here (Ram, 2026-10-07: "derived from a
 *        source and user does not need to change it"). No title input, no
 *        chips. The box is how the person adds to it: the tied chat
 *        (`matter:<id>`, the same conversation Now's card holds) writes a
 *        status, a date, the step, done / cancelled or a note into the
 *        folder with a verbatim quote and Undo (js/agent/matter-capture.js);
 *        it never rewrites the title or the messages.
 *   MP2  Nothing here is model-written at render: every value is a stored
 *        field, every label a stored word (the step's action label, the
 *        kind's "Already done"). The same buttons as the Now card, so the
 *        page is a superset of the card, never a rival.
 *   MP3  One conversation per thing: the box's key IS Now's `thingKey`
 *        for the folder (its id already reads "matter:…"), docked beside
 *        the page by PageChat.
 *   MP4  The source is one tap away, never the first tap: each message row
 *        opens in Gmail (or Messages for a text); the title never leaves
 *        nenva.
 *
 * The CSS is the commitment sheet's own (`cm-*`, css/apps/commitments.css):
 * the same design language shared literally, not a copy. Pure parts
 * (stateWord, factsLine, kindWord) are Node-testable (tests/matter-page-test.js).
 */
const MatterPage = {
    APP: 'matter',
    KIND_WORD: { appointment: 'Appointment', bill: 'Bill', order: 'Order', reservation: 'Reservation', subscription: 'Subscription', other: '' },
    STATE_WORD: { open: '', done: 'Done', past: 'Past', ignored: 'Ignored', cancelled: 'Cancelled' },
    _open: null,      // the folder id showing
    _from: null,      // where the person came from: the back link's label
    _mounted: false,

    esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); },

    // ── Pure ────────────────────────────────────────────────────────────

    kindWord(m) { return (m && (m.kindWord || this.KIND_WORD[m.kind])) || ''; },
    stateWord(m) { return (m && this.STATE_WORD[m.state]) || (m && m.state && m.state !== 'open' ? m.state.charAt(0).toUpperCase() + m.state.slice(1) : ''); },
    /** When a thing is, in words; `now` fixes "today" / "tomorrow". */
    whenWord(m, now = new Date()) {
        if (!m || !m.when || !m.when.date) return '';
        const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        const today = iso(now), tomorrow = iso(new Date(now.getTime() + 86400000));
        const d = new Date(`${m.when.date}T${m.when.time || '12:00'}:00`);
        const day = m.when.date === today ? 'Today' : m.when.date === tomorrow ? 'Tomorrow'
            : d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
        return m.when.time ? `${day}, ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : day;
    },
    /** The one facts line under the title: kind · when · amount · place · how many messages. Pure. */
    factsLine(m, now = new Date(), messages = null) {
        const msgs = messages || (typeof Matters !== 'undefined' ? Matters.messagesOf(m) : (m.sources || []));
        const bits = [];
        const k = this.kindWord(m); if (k) bits.push(k);
        const w = this.whenWord(m, now); if (w) bits.push(w);
        if (m.amount && m.amount !== 'null') bits.push(String(m.amount));
        if (m.place) bits.push(String(m.place));
        else if (m.vendor) bits.push(String(m.vendor));
        if (m.code) bits.push(`#${m.code}`);
        if (msgs.length) bits.push(`${msgs.length} message${msgs.length === 1 ? '' : 's'}`);
        return bits.join(' · ');
    },
    /** Where the back link goes, by the app the person was on. */
    fromLabel(app) {
        if (!app || app === 'home') return 'Now';
        if (app === 'commitments') return 'Commitments';
        if (app === 'fyi') return 'Insights';
        if (app === 'agent' || app === 'conversations') return 'Chat';
        return typeof AppManager !== 'undefined' && AppManager.appLabel ? AppManager.appLabel(app) : 'Back';
    },

    // ── The page ────────────────────────────────────────────────────────

    mount() {
        if (this._mounted || typeof Matters === 'undefined' || typeof document === 'undefined') return;
        this._mounted = true;
        const page = document.createElement('main');
        page.id = `${this.APP}-view`;
        page.className = 'view app-view cm-page mp-page';
        page.setAttribute('aria-label', 'Something nenva is keeping track of');
        page.innerHTML = '<div class="cm-content"></div>';
        (document.getElementById('app-views') || document.body).append(page);
        page.addEventListener('click', e => this.onClick(e));
        if (typeof AppManager !== 'undefined') AppManager.register(this.APP, { render: () => this.render() });
    },
    /** Open one folder (by id or an old alias). The back link names where you came from. */
    open(id) {
        this.mount();
        const m = this._mounted ? Matters.get(id) : null;
        if (!m) return false;
        this._open = m.id;
        this._show();
        return true;
    },
    /**
     * A message with NO folder (Ram, 2026-10-07: "it should open the detail
     * page"): the same sheet, built from the message itself — what it said,
     * when, the amount, its one door to Gmail or Messages, Not useful /
     * Mute — so there is one detail surface. Nothing is stored: the sheet
     * is read off the analysis each time (`virtual`).
     */
    openForMessage(messageId) {
        this.mount();
        if (!this._mounted || !this.virtualFor(messageId)) return false;
        this._open = `insight:${messageId}`;
        this._show();
        return true;
    },
    _show() {
        if (AppManager.currentApp !== this.APP) {
            this._from = this.fromLabel(AppManager.currentApp);
            AppManager.openApp(this.APP);
        } else this.render();
    },
    /** The folder-shaped view of a message with no folder, or null. */
    virtualFor(messageId) {
        if (typeof EmailApp === 'undefined' || !EmailApp.priorityAnalyses) return null;
        const a = EmailApp.priorityAnalyses[messageId];
        const e = EmailApp.emailById ? EmailApp.emailById(messageId) : null;
        if (!a || !e) return null;
        const text = e.source === 'imessage';
        const from = text && typeof FyiPage !== 'undefined' && FyiPage._chatLabel ? FyiPage._chatLabel(e)
            : String(e.fromName || (typeof EmailUI !== 'undefined' && EmailUI.extractName ? EmailUI.extractName(e.from) : e.from) || '').trim();
        const when = EmailApp._matterDate ? EmailApp._matterDate(a) : null;
        const label = (a.type && EmailApp.INSIGHT_TYPE_LABELS && EmailApp.INSIGHT_TYPE_LABELS[a.type]) || '';
        const human = t => (typeof UIUtils !== 'undefined' && UIUtils.humanizeIsoDates ? UIUtils.humanizeIsoDates(t) : t);
        const gist = (Array.isArray(a.insights) ? a.insights : []).map(t => human(String(t || '').trim())).filter(Boolean).slice(0, 5);
        const taskId = EmailApp.taskIdForEmail ? EmailApp.taskIdForEmail(messageId) : null;
        return { id: `insight:${messageId}`, virtual: true, messageId, kind: 'other', state: 'open',
            kindWord: label && label !== 'Other' ? label.replace(/s$/, '') : '',
            title: (typeof UIUtils !== 'undefined' && UIUtils.humanizeIsoDates ? UIUtils.humanizeIsoDates(a.summary || e.subject || '') : (a.summary || e.subject || '')) || '(no subject)',
            status: '', gist, amount: a.amount && a.amount !== 'null' ? String(a.amount) : null, when: { date: when, time: null },
            sources: [{ id: messageId, kind: text ? 'imessage' : 'email', at: e.date, from, summary: human(e.subject || '') }],
            next: null, tasks: taskId ? [taskId] : [], log: [] };
    },
    _current() {
        if (!this._open) return null;
        if (String(this._open).startsWith('insight:')) return this.virtualFor(this._open.slice(8));
        return Matters.get(this._open);
    },
    render() {
        const host = document.querySelector(`#${this.APP}-view .cm-content`);
        if (!host) return;
        const m = this._current();
        if (!m) { host.innerHTML = `<button type="button" class="back-link cm-back" data-mp="back">‹ ${this.esc(this._from || 'Now')}</button><p class="cm-history">This one is gone.</p>`; return; }
        host.innerHTML = this.sheetHtml(m);
    },

    // ── Markup ──────────────────────────────────────────────────────────

    /** Every message filed on it, newest first, each with its door. */
    messagesHtml(m) {
        const msgs = Matters.messagesOf(m).slice().reverse();
        if (!msgs.length) return '';
        const esc = this.esc.bind(this);
        const when = at => at ? new Date(at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
        const door = s => {
            if (s.kind === 'slack') return 'Open in Slack';
            const text = s.kind === 'imessage' || /^imsg:/.test(String(s.id));
            if (text) return 'Open in Messages';
            return typeof EmailApp !== 'undefined' && EmailApp.openMessageLabel ? EmailApp.openMessageLabel(s.id) : 'Open email';
        };
        return `<section class="cm-steps mp-messages"><h2 class="cm-eyebrow">Messages about it</h2>${msgs.map(s => `<div class="cm-step">
            <span class="cm-step-when">${esc(when(s.at))}</span>
            <span class="cm-step-title mp-msg"><span class="mp-msg-from">${esc(s.kind === 'slack' ? 'Slack' : s.kind === 'imessage' ? 'Text' : 'Email')} from ${esc(s.from || s.address || 'unknown')}</span>${s.summary ? `<br><span class="mp-msg-sum">${esc(s.summary)}</span>` : ''}${s.slack?.invalidated ? '<br><span class="mp-msg-sum">Source changed or is unavailable. Needs review.</span>' : ''}</span>
            <button type="button" class="cm-link mp-msg-open" data-mp="message" data-id="${esc(s.id)}">${esc(door(s))}</button></div>`).join('')}</section>`;
    },
    /** The calendar event it is (Matters.mergeCalendar keeps its facts on the folder). */
    calendarHtml(m) {
        const c = m.calendar;
        if (!c || !m.calendarEventId) return '';
        const esc = this.esc.bind(this);
        const day = c.date ? new Date(`${c.date}T${c.time || '12:00'}:00`).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', ...(c.time ? { hour: 'numeric', minute: '2-digit' } : {}) }) : '';
        const extra = [c.location, c.yourResponse ? `Your response: ${c.yourResponse}` : ''].filter(Boolean).join(' · ');
        return `<section class="cm-steps"><h2 class="cm-eyebrow">On your calendar</h2><div class="cm-step">
            <span class="cm-step-when">${esc(day)}</span>
            <button type="button" class="cm-step-title" data-mp="event" data-id="${esc(m.calendarEventId)}">${esc(c.title || 'Event')}${extra ? `<br><span class="mp-msg-sum">${esc(extra)}</span>` : ''}</button></div></section>`;
    },
    /** The tasks about it: the person's own and the one its step made. Commitments are the truth; the old blob is the fallback. */
    tasksOf(m) {
        const ids = [...new Set([...(m.tasks || []), m.next && m.next.taskId].filter(Boolean))];
        if (!ids.length) return [];
        const out = [];
        const C = typeof Commitments !== 'undefined' && Commitments._inited ? Commitments : null;
        let items = null;
        for (const id of ids) {
            const c = C ? C.get(id) : null;
            if (c) { out.push({ id, title: c.title, state: c.state === 'done' ? 'Done' : c.state === 'dropped' ? 'Ignored' : 'Open', date: c.when && c.when.date }); continue; }
            if (!items) { try { items = (StorageManager.get('schedule') || {}).scheduleItems || []; } catch { items = []; } }
            const t = items.find(x => x && x.id === id);
            if (t) out.push({ id, title: t.title, state: t.lastCompletedDate ? 'Done' : (t.history && Object.values(t.history).includes('abandoned')) ? 'Ignored' : 'Open', date: t.scheduledDate });
        }
        return out;
    },
    tasksHtml(m) {
        const tasks = this.tasksOf(m);
        if (!tasks.length) return '';
        const esc = this.esc.bind(this);
        const day = d => d ? new Date(`${d}T12:00:00`).toLocaleDateString([], { month: 'short', day: 'numeric' }) : '';
        return `<section class="cm-steps"><h2 class="cm-eyebrow">Tasks about it</h2>${tasks.map(t => `<div class="cm-step${t.state === 'Open' ? '' : ' is-done'}">
            <span class="cm-step-when">${esc(day(t.date))}</span>
            <button type="button" class="cm-step-title" data-mp="task" data-id="${esc(t.id)}">${esc(t.title)}</button>
            <span class="cm-step-when mp-task-state">${esc(t.state)}</span></div>`).join('')}</section>`;
    },
    /** What happened outside its messages (calendar moves, tasks done), newest first. */
    logHtml(m) {
        const log = (m.log || []).slice().reverse().slice(0, 8);
        if (!log.length) return '';
        const esc = this.esc.bind(this);
        return `<section class="cm-log"><h2 class="cm-eyebrow">What happened</h2>${log.map(l => `<div class="cm-log-row">
            <span class="cm-log-day">${esc(l.at ? new Date(l.at).toLocaleDateString([], { month: 'short', day: 'numeric' }) : '')}</span>
            <span class="cm-log-text">${esc(l.text || '')}</span></div>`).join('')}</section>`;
    },
    /** nenva's line: where it stands and the step (MP2: the stored words); for a message with no folder, what it said when it was read. */
    agentHtml(m, step) {
        const esc = this.esc.bind(this);
        if (m.virtual) {
            const lines = m.gist && m.gist.length ? m.gist : [];
            return `<div class="cm-agent"><span class="cm-agent-who">nenva</span><p>${lines.length ? lines.map(esc).join('<br>') : 'Nothing to do here; kept for your information.'}</p></div>`;
        }
        const what = step && step.what && step.what !== m.status ? step.what : '';
        const text = [m.status, what].filter(Boolean).join('. ');
        if (!text) return '';
        return `<div class="cm-agent"><span class="cm-agent-who">nenva</span><p>${esc(text)}</p></div>`;
    },
    chatHtml(m, now) {
        if (typeof PageChat === 'undefined') return '';
        return `<div class="cm-chat">${PageChat.html(m.id, { title: m.virtual ? m.title : Matters.titleOf(m), body: this.factsLine(m, now),
            placeholder: 'Add a detail, or tell me what to do with this…', onChange: () => this.render() })}</div>`;
    },
    sheetHtml(m) {
        const esc = this.esc.bind(this);
        const now = new Date();
        const step = m.virtual ? null : Matters.openStep(m);
        const state = m.virtual ? 'For your information' : this.stateWord(m);
        // "Already done" sits beside a step that opens something (a draft,
        // a link); a plain "do it" step's one button IS Done.
        const dismiss = step && step.how !== 'none' ? ((Matters.card(m) || {}).dismiss || '') : '';
        return `<button type="button" class="back-link cm-back" data-mp="back">‹ ${esc(this._from || 'Now')}</button>
            <article class="cm-sheet mp-sheet">
                <div class="cm-sheet-head">
                    <h1 class="mp-title">${esc(m.virtual ? m.title : Matters.titleOf(m))}</h1>
                    ${step ? `<button type="button" class="cm-btn is-primary" data-mp="step">${esc(Matters.actionLabel(step))}</button>`
                        : state ? `<span class="cm-btn is-static">${esc(state)}</span>` : ''}
                </div>
                <p class="cm-facts mp-facts">${esc(this.factsLine(m, now))}</p>
                ${m.evidenceNeedsReview ? '<p class="cm-facts">Some Slack evidence changed or is unavailable. Its earlier interpretation needs review.</p>' : ''}
                ${this.agentHtml(m, step)}
                ${this.messagesHtml(m)}
                ${this.calendarHtml(m)}
                ${this.tasksHtml(m)}
                ${this.logHtml(m)}
                ${this.chatHtml(m, now)}
                ${m.virtual ? `<div class="cm-more">
                    <button type="button" class="cm-link" data-mp="notuseful">Not useful</button>
                    ${m.sources[0].kind === 'imessage' ? '' : '<button type="button" class="cm-link" data-mp="mute">Mute this sender</button>'}
                    <button type="button" class="cm-link cm-danger mp-feedback" data-mp="delete">Delete</button>
                </div>` : m.state === 'open' ? `<div class="cm-more">
                    ${dismiss ? `<button type="button" class="cm-link" data-mp="done">${esc(dismiss)}</button>` : ''}
                    <button type="button" class="cm-link" data-mp="ignore">Ignore</button>
                    ${Matters.messagesOf(m).length ? '<button type="button" class="cm-link mp-feedback" data-mp="notuseful">Not useful</button>' : ''}
                </div>` : ''}
            </article>`;
    },

    // ── Acting (the card's own doors; nothing else writes from here) ───

    _nowChanged() {
        if (typeof SimpleExperience !== 'undefined') SimpleExperience._homeMarkup = null;
        if (typeof Widgets !== 'undefined' && Widgets.refresh) Widgets.refresh();
    },
    openMessage(id) {
        if (typeof Matters !== 'undefined') {
            const m = Matters.forSource?.(id), s = m?.sources.find(source => source.id === id);
            if (s?.kind === 'slack') {
                const url = Matters.sourceUrl(s);
                if (url && typeof AppManager !== 'undefined') AppManager.openExternal(url);
                return;
            }
        }
        const rec = typeof EmailApp !== 'undefined' && EmailApp.sourceRecordById ? EmailApp.sourceRecordById(id) : null;
        if (rec && typeof IMessageSource !== 'undefined') { IMessageSource.openChat(rec); return; }
        if (typeof EmailApp !== 'undefined' && EmailApp.openMessageFrom) EmailApp.openMessageFrom(id);
    },
    async onClick(e) {
        const el = e.target.closest('[data-mp]');
        if (!el) return;
        let act = el.dataset.mp;
        const m = this._current();
        if (act === 'back') { AppManager.goBack(); return; }
        if (act === 'message') { this.openMessage(el.dataset.id); return; }
        if (act === 'task') {
            const id = el.dataset.id;
            if (typeof CommitmentsPage !== 'undefined' && CommitmentsPage.takesOver() && Commitments.get(id)) CommitmentsPage.open(id);
            else if (typeof ScheduleApp !== 'undefined') { ScheduleApp.init(); setTimeout(() => ScheduleApp.openEditor(id, { origin: 'matter' }), 0); }
            return;
        }
        if (act === 'event') { if (typeof CalendarApp !== 'undefined' && CalendarApp.openEvent) CalendarApp.openEvent(el.dataset.id); return; }
        if (!m) return;
        if (m.virtual) {
            // A message with no folder: feedback and the sender's rules, then back to the list.
            if (act === 'notuseful' && typeof EmailApp !== 'undefined') { EmailApp.recordInsightFeedback(m.messageId, false); AppManager.goBack(); return; }
            if (act === 'mute' && typeof EmailApp !== 'undefined') { EmailApp.muteSenderOf(m.messageId); AppManager.goBack(); return; }
            if (act === 'delete' && typeof EmailApp !== 'undefined') {
                const ok = await UIUtils.confirm('Delete this', 'Remove what nenva kept from this message? The message itself stays in your mailbox.', '', { confirmText: 'Delete' });
                if (ok && EmailApp.deleteInsight(m.messageId)) { UIUtils.showToast('Deleted', 'success'); AppManager.goBack(); }
                return;
            }
            return;
        }
        if (act === 'step') {
            const step = Matters.openStep(m);
            if (step && step.how === 'none') act = 'done';
            else { Matters.openDraft(m.id); this.render(); this._nowChanged(); return; }
        }
        if (act === 'done') { Matters.markStep(m.id, 'next'); this.render(); this._nowChanged(); if (typeof UIUtils !== 'undefined') UIUtils.showToast('Marked done', 'success'); return; }
        if (act === 'notuseful') {
            // Feedback on the newest message (teaches what to skip from that sender), then the folder is let go, with Undo.
            const last = Matters.messagesOf(m).pop();
            if (last && typeof EmailApp !== 'undefined' && EmailApp.recordInsightFeedback) EmailApp.recordInsightFeedback(last.id, false);   // its own toast says what was learned
            Matters.ignore(m.id); this.render(); this._nowChanged();
            return;
        }
        if (act === 'ignore') {
            const before = Matters.ignore(m.id);
            this.render(); this._nowChanged();
            if (before && typeof UIUtils !== 'undefined') UIUtils.showToast(`Ignored: ${Matters.titleOf(m)}`, 'success', 7000, {
                actionLabel: 'Undo', onAction: () => { Matters.unignore(m.id, before); this.render(); this._nowChanged(); }
            });
        }
    }
};

// A chat's link to a folder opens this page (the assistant's list_matters /
// get_matter ids); navigation only.
if (typeof RecordLinks !== 'undefined' && RecordLinks.register) {
    RecordLinks.register('matter', {
        label: 'tracked item', hint: 'something nenva tracks from mail or texts — use its id from list_matters',
        exists: id => (typeof Matters !== 'undefined' ? !!Matters.get(id) : null),
        open: id => MatterPage.open(id)
    });
}

if (typeof module !== 'undefined' && module.exports) module.exports = MatterPage;
