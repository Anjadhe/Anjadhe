/**
 * The Commitments page (docs/COMMITMENTS.md §5, phase 2, 2026-10-03):
 * everything the person said they would do, on one page, kept by their
 * agent. Behind the `commitments` flag; the old Tasks and Projects pages are
 * untouched until phase 4.
 *
 *   - One line joined from counts (never model-written).
 *   - The box: the agent's box (PageChat), leaning toward a new commitment.
 *     Words in, proposals out (Commitments.capture), each shown as facts
 *     before anything is added (C2). Words about one you already have come
 *     back as a proposed change to it; a question or a request for work
 *     opens the chat as an overlay on this page
 *     (js/components/page-chat.js, 2026-10-04). No suggestion chips under
 *     it (removed 2026-10-05, by request: not useful).
 *   - Today, Moving (the big ones with their next step), Waiting on others,
 *     Later, Done (hidden until Show completed is on). No date-bucket, group or tag nav (C5).
 *   - The sheet: the facts as chips you tap to change, the steps, the note,
 *     Done / Ignore / Add a note / Delete in plain view (2026-10-06, by
 *     request: no More fold; Someday retired), and the box that opens the
 *     commitment's own chat (`task:<id>`) as an overlay on the sheet (PageChat).
 *
 * Every write is Commitments' one door with by:'you', and every write offers
 * Undo (C4). Nothing here decides anything for the person: the judged read
 * and its offers are phase 3.
 */
const CommitmentsPage = {
    LABEL: 'Commitments',
    _open: null,          // the id whose sheet is showing, or null
    _proposals: null,     // capture results waiting for the person
    _editing: null,       // the chip being edited on the sheet
    _showDone: false,

    esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); },

    // ── What goes where (pure, Node-testable) ───────────────────────────

    /**
     * A bigger goal is an OUTCOME (a project, or anything with "done looks
     * like"), not merely something with steps: a task with work sessions under
     * it stays a task, with its own day, tick and place in Today.
     */
    isBig(c, all) { return !!(c.outcome || Commitments.shapeOf(c) === 'goal'); },

    /**
     * The page's sections from the facts. Pure over `all` and `today`.
     * A step of an open big commitment lives under it (Moving) unless it
     * is due today, which brings it to Today.
     */
    sections(all, today) {
        const C = Commitments;
        const open = all.filter(c => c.state === 'open');
        const due = c => C.repeats(c) ? (C.occursOn(c, today) && !C.isDone(c, today)) : !!(c.when && c.when.date && c.when.date <= today);
        const todayList = open.filter(c => due(c) && !this.isBig(c, all));
        const inToday = new Set(todayList.map(c => c.id));
        const moving = open.filter(c => this.isBig(c, all) && !c.parent);
        const bigOpen = new Set(moving.map(c => c.id));
        const waiting = open.filter(c => c.waitingOn && !inToday.has(c.id));
        const inWaiting = new Set(waiting.map(c => c.id));
        const later = open.filter(c => !inToday.has(c.id) && !bigOpen.has(c.id) && !inWaiting.has(c.id)
            && !(c.parent && bigOpen.has(c.parent)) && !this.isBig(c, all));
        const done = all.filter(c => c.state === 'done' || c.state === 'dropped')
            .sort((a, b) => String(b.doneAt || b.updatedAt).localeCompare(String(a.doneAt || a.updatedAt))).slice(0, 20);
        const tomorrow = C.iso(new Date(new Date(`${today}T12:00:00`).getTime() + 86400000));
        // A repeat's next day it still needs doing (done today: from tomorrow).
        const at = c => (C.repeats(c) ? C.nextOn(c, C.isDone(c, today) ? tomorrow : today) : (c.when && c.when.date)) || c.by || '9999';
        const timeOf = c => (C.repeats(c) ? C.timeOn(c, today).time : (c.when && c.when.time)) || '99:99';
        todayList.sort((a, b) => {
            const ao = !C.repeats(a) && a.when.date < today, bo = !C.repeats(b) && b.when.date < today;
            return (bo - ao) || (ao && bo ? a.when.date.localeCompare(b.when.date) : 0) || timeOf(a).localeCompare(timeOf(b)) || a.title.localeCompare(b.title);
        });
        moving.sort((a, b) => (a.by || '9999').localeCompare(b.by || '9999') || a.title.localeCompare(b.title));
        later.sort((a, b) => at(a).localeCompare(at(b)) || a.title.localeCompare(b.title));
        waiting.sort((a, b) => String(a.waitingOn.since).localeCompare(String(b.waitingOn.since)));
        return { today: todayList, moving, waiting, later, done };
    },

    /** The one line, joined from counts. Pure. */
    line(sec, today, all = null) {
        const overdue = sec.today.filter(c => !Commitments.repeats(c) && c.when.date < today).length;
        const parts = [];
        const slipping = all ? all.filter(c => { const r = Commitments.shownRead(c, all, today); return r && (r.stance === 'slipping' || r.stance === 'stuck'); }).length : 0;
        const n = sec.today.length;
        parts.push(n ? `${n} for today` : 'Nothing due today');
        if (overdue) parts.push(`${overdue} overdue`);
        if (sec.moving.length) parts.push(`${sec.moving.length} bigger ${sec.moving.length === 1 ? 'one' : 'ones'} moving`);
        if (sec.waiting.length) parts.push(`${sec.waiting.length} waiting on others`);
        if (slipping) parts.push(`${slipping} I'd look at`);
        return parts.join(', ') + '.';
    },

    // ── The assistant's read (phase 3) ──────────────────────────────────

    STANCE_WORD: { slipping: 'Slipping', waiting: 'Waiting', stuck: 'Stuck', 'done?': 'Maybe done', 'drop?': 'Still wanted?', fine: 'On track' },
    offerLabel(o, today) {
        // An offer that changes the commitment says exactly what it does, in
        // code's words ("Buy them now" on a mark-done offer would lie). The
        // model's words are kept only for offers that open a conversation.
        if (o.kind === 'move') { const w = this.dayWord(o.date, today); return `Move to ${/^(Today|Tomorrow)$/.test(w) ? w.toLowerCase() : w}`; }
        if (['done', 'drop'].includes(o.kind)) return { done: 'Mark done', drop: 'Let it go' }[o.kind];
        if (o.label) return o.label;
        return { plan: 'Plan it with me', prepare: 'Plan time for it', follow_up: 'Draft a nudge', done: 'Mark done', drop: 'Let it go', talk: 'Talk it through' }[o.kind] || 'Do this';
    },
    /** What the chat is asked when an offer needs a conversation (the agent proposes; every write still asks). */
    offerPrompt(o, c) {
        const t = `“${c.title}”`;
        if (o.kind === 'plan') return `Help me plan ${t}. Ask me only what you do not already know, then propose the steps with dates.`;
        if (o.kind === 'prepare') return `Plan time for me to work on ${t} before it is due. Look at my calendar and propose sessions.`;
        if (o.kind === 'follow_up') return `Draft a short, friendly follow-up to ${c.waitingOn ? c.waitingOn.who : 'them'} about ${t}. Do not send it; show me the draft.`;
        const why = c.read && c.read.why ? ` ${c.read.why}` : '';
        return `Let's talk about ${t}.${why}`;
    },
    _refreshReads() {
        const now = Date.now();
        if (Commitments._reading || now - (this._readAt || 0) < 10 * 60000) return;
        this._readAt = now;
        Commitments.refreshReads().then(n => { if (n && AppManager.currentApp === 'commitments') this.render(); }).catch(() => {});
    },

    // ── Words for facts ─────────────────────────────────────────────────

    DAYS: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
    dayWord(iso, today) {
        if (!iso) return '';
        const d = new Date(`${iso}T12:00:00`), t = new Date(`${today}T12:00:00`);
        const delta = Math.round((d - t) / 86400000);
        if (delta === 0) return 'Today';
        if (delta === 1) return 'Tomorrow';
        if (delta === -1) return 'Yesterday';
        if (delta > 1 && delta < 7) return this.DAYS[d.getDay()];
        return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', ...(d.getFullYear() !== t.getFullYear() ? { year: 'numeric' } : {}) });
    },
    timeWord(hm) {
        if (!hm) return '';
        const [h, m] = hm.split(':').map(Number);
        return new Date(2000, 0, 1, h, m).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    },
    whenWord(c, today) {
        const C = Commitments;
        const w = c.when || {};
        const next = C.repeats(c) ? C.nextOn(c, today) : null;
        const day = C.repeats(c) ? this.dayWord(next, today) : this.dayWord(w.date, today);
        // A repeat's next day shows that day's own time (moved for it only).
        const t = next ? C.timeOn(c, next) : { time: w.time, end: w.end, moved: false };
        return [day, t.time ? this.timeWord(t.time) + (t.end ? `–${this.timeWord(t.end)}` : '') : '', t.moved ? '(that day only)' : ''].filter(Boolean).join(' ');
    },
    repeatWord(c) {
        if (!Commitments.repeats(c)) return '';
        const r = c.repeat;
        if (r.rule === 'weekly' || r.rule === 'custom') return `Every ${r.days.map(d => this.DAYS[d]).join(', ')}`;
        return { daily: 'Every day', weekdays: 'Weekdays', monthly: 'Every month', yearly: 'Every year' }[r.rule] || r.rule;
    },
    remindWord(c) {
        const r = c.remind;
        if (!r) return '';
        const parts = [];
        if (r.minutesBefore === 0) parts.push('At the start');
        else if (r.minutesBefore) parts.push(r.minutesBefore >= 60 ? `${Math.round(r.minutesBefore / 60)} h before` : `${r.minutesBefore} min before`);
        for (const d of r.daysBefore || []) if (d > 0) parts.push(`${d} day${d === 1 ? '' : 's'} before`);
        return parts.join(', ');
    },
    factsLine(c, today, all, under = null) {
        const bits = [];
        const w = this.whenWord(c, today);
        if (w) bits.push(!Commitments.repeats(c) && c.when && c.when.date && c.when.date < today ? `<span class="cm-late">${this.esc(w)}</span>` : this.esc(w));
        const rp = this.repeatWord(c); if (rp) bits.push(this.esc(rp));
        if (c.by) bits.push(`by ${this.esc(this.dayWord(c.by, today))}`);
        if (c.parent && c.parent !== under) { const p = all.find(x => x.id === c.parent); if (p) bits.push(this.esc(p.title)); }
        if (c.waitingOn) bits.push(`waiting on ${this.esc(c.waitingOn.who)}`);
        const steps = all.filter(k => k.parent === c.id && k.state === 'open').length;
        if (steps) bits.push(`${steps} step${steps === 1 ? '' : 's'} open`);
        return bits.join(' · ');
    },

    // ── Mount and open ──────────────────────────────────────────────────

    mount() {
        if (this._mounted || typeof Commitments === 'undefined') return;
        if (typeof FEATURES === 'undefined' || !FEATURES.isEnabled('commitments')) return;
        this._mounted = true;
        const page = document.createElement('main');
        page.id = 'commitments-view';
        page.className = 'view app-view cm-page';
        page.setAttribute('aria-labelledby', 'cm-title');
        page.innerHTML = '<div class="cm-content"></div>';
        (document.getElementById('app-views') || document.body).append(page);
        page.addEventListener('click', e => this.onClick(e));
        page.addEventListener('submit', e => this.onSubmit(e));
        page.addEventListener('change', e => this.onChange(e));
        page.addEventListener('input', e => { if (e.target.classList.contains('cm-attach-input')) { this._attachQuery = e.target.value; this._drawAttachPicks(); } });
        page.addEventListener('keydown', e => {
            if (!e.target.classList.contains('cm-attach-input')) return;
            if (e.key === 'Escape') { this._attaching = false; this._attachQuery = ''; this.render(); return; }
            if (e.key !== 'Enter') return;
            e.preventDefault();
            const p = this._picks;
            if (p && p.link && !p.link.attached) this.attachItems([{ kind: 'link', id: p.link.url, title: p.link.title }]);
            else if (p && p.items.length === 1) this.attachItems([p.items[0]]);
        });
        this._wireAttachDrop(page);
        if (typeof AppManager !== 'undefined') AppManager.register('commitments', { render: () => this.render() });
    },
    /**
     * Commitments is THE surface (phase 5): every door that opened a task or
     * a project (Now, Today, chat links, Insights, the calendar, ⌘K, the
     * Tasks and Projects launchers) opens the page or the sheet instead.
     */
    takesOver() {
        return typeof Commitments !== 'undefined' && !!Commitments._inited && this._mounted;
    },
    open(id = null, { text = '' } = {}) {
        this.mount();
        if (!this._mounted) return;
        this._open = id;
        this._prefill = text || '';
        this._editing = null;
        if (AppManager.currentApp !== 'commitments') AppManager.openAppFromLauncher('commitments');
        this.render();
    },

    // ── Render ──────────────────────────────────────────────────────────

    render() {
        const host = document.querySelector('#commitments-view .cm-content');
        if (!host) return;
        Commitments.reload();
        if (this._open && !Commitments.get(this._open)) this._open = null;
        const paged = typeof PageChat !== 'undefined';
        if (paged && !this._open && this._prefill) { PageChat.setDraft(this.BOX, this._prefill); this._prefill = ''; this._focusCapture = true; }
        host.innerHTML = this._open ? this.sheetHtml(Commitments.get(this._open)) : this.listHtml();
        this._refreshReads();
        const input = host.querySelector('.cm-capture input') || (this._open ? null : host.querySelector('.page-chat-box input'));
        if (input && this._prefill) { input.value = this._prefill; this._prefill = ''; this._focusCapture = true; }
        if (input && this._focusCapture) { input.focus(); this._focusCapture = false; }
    },

    // ── The box (PageChat): the agent's box, on this page ───────────────

    BOX: 'page:commitments',
    boxHtml() {
        if (typeof PageChat === 'undefined') return this.captureHtml(null);
        return PageChat.html(this.BOX, { title: this.LABEL, label: 'Add a commitment, or tell nenva what to change',
            placeholder: 'What will you do? Or tell me what to change', route: text => this.routeBox(text), onChange: () => this.render() });
    },
    /**
     * The box's fast path (PC4): one small call reads the words as a new
     * commitment (the lean) or a change to one, shown as tap cards. A
     * question or a request for work returns false and opens the page's
     * conversation over it, with the words sent.
     */
    async routeBox(text) {
        this._proposals = null;
        const res = await Commitments.capture(text, { parent: null });
        if (res.ask) return false;
        this._proposals = res.proposals.length ? { parent: null, items: res.proposals, guessed: !!res.guessed } : null;
        this.render();
        return true;
    },
    sheetChatHtml(c) {
        if (typeof PageChat === 'undefined') return '<button type="button" class="nv-card-reply nv-card-reply-door cm-chat" data-cm="chat"><span class="nv-card-reply-hint">Tell me what to do with this…</span></button>';
        return `<div class="cm-chat">${PageChat.html(`task:${c.id}`, { title: c.title, body: this.factsLine(c, Commitments.today(), Commitments.all()).replace(/<[^>]+>/g, ''),
            placeholder: 'Tell me what to do with this…', onChange: () => this.render() })}</div>`;
    },
    /** A conversation about one commitment, over its sheet. */
    talk(c, prompt) {
        if (typeof PageChat === 'undefined') {
            if (typeof AgentUI !== 'undefined' && AgentUI.askWithPrompt) AgentUI.askWithPrompt(prompt, { newChat: true, todayKey: `task:${c.id}` });
            return;
        }
        this._open = c.id; this._editing = null; this._proposals = null;
        if (AppManager.currentApp !== 'commitments') AppManager.openAppFromLauncher('commitments');
        this.render();
        PageChat.open(`task:${c.id}`, prompt);
    },
    rowHtml(c, today, all, under = null) {
        const big = this.isBig(c, all);
        const kids = big ? all.filter(k => k.parent === c.id) : [];
        const doneKids = kids.filter(k => k.state === 'done' || k.state === 'dropped').length;
        const next = big ? kids.filter(k => k.state === 'open').sort((a, b) => ((a.when && a.when.date) || '9999').localeCompare((b.when && b.when.date) || '9999'))[0] : null;
        const facts = big
            ? [kids.length ? `${doneKids} of ${kids.length} done` : 'No steps yet', next ? `next: ${this.esc(next.title)}${next.when && next.when.date ? ` (${this.esc(this.dayWord(next.when.date, today))})` : ''}` : '', c.by ? `by ${this.esc(this.dayWord(c.by, today))}` : ''].filter(Boolean).join(' · ')
            : this.factsLine(c, today, all, under);
        const doneToday = Commitments.repeats(c) && Commitments.isDone(c, today);
        const read = Commitments.shownRead(c, all, today);
        return `<div class="cm-row${big ? ' is-big' : ''}" data-id="${this.esc(c.id)}">
            ${big ? '<span class="cm-big-mark" aria-hidden="true"></span>' : `<button type="button" class="cm-check${doneToday ? ' is-on' : ''}" data-cm="done" data-id="${this.esc(c.id)}" aria-label="Mark ${this.esc(c.title)} done"></button>`}
            <button type="button" class="cm-row-main" data-cm="open" data-id="${this.esc(c.id)}">
                <span class="cm-row-title">${this.esc(c.title)}</span>
                ${facts ? `<span class="cm-row-facts">${facts}</span>` : ''}
                ${read ? `<span class="cm-read is-${this.esc(read.stance.replace('?', ''))}">${this.esc(read.why || this.STANCE_WORD[read.stance])}</span>` : ''}
            </button>
        </div>`;
    },

    completedToggleHtml() {
        return `<button type="button" class="cm-completed-toggle" data-cm="toggle-done" role="switch" aria-checked="${this._showDone}"><span>Show completed</span><span class="cm-toggle-track" aria-hidden="true"></span></button>`;
    },

    listHtml() {
        const all = Commitments.all();
        const today = Commitments.today();
        const sec = this.sections(all, today);
        const block = (title, list) => list.length ? `<section class="cm-section"><h2 class="cm-eyebrow">${title} <span class="cm-count">${list.length}</span></h2>${list.map(c => this.rowHtml(c, today, all)).join('')}</section>` : '';
        // Its door is Settings › Memory in the simple shell (2026-10-05), so
        // the way back is named for it.
        const back = typeof SimpleExperience !== 'undefined' && SimpleExperience.enabled && typeof SimpleSettings !== 'undefined'
            ? '<button type="button" class="back-link cm-back" data-cm="to-memory">‹ Memory</button>' : '';
        return `<header class="cm-head">${back}
                <div class="cm-heading-row"><h1 id="cm-title" class="cm-h1">${this.LABEL}</h1>${this.completedToggleHtml()}</div>
                <p class="cm-line">${this.esc(this.line(sec, today, all))}</p>
            </header>
            ${this.boxHtml()}
            ${this.proposalsHtml()}
            ${block('Today', sec.today)}
            ${block('Moving', sec.moving)}
            ${block('Waiting on others', sec.waiting)}
            ${block('Later', sec.later)}
            ${this._showDone && sec.done.length ? `<section class="cm-section"><h2 class="cm-eyebrow">Done <span class="cm-count">${sec.done.length}</span></h2>
                ${sec.done.map(c => `<div class="cm-row is-done"><span class="cm-check is-on" aria-hidden="true"></span><button type="button" class="cm-row-main" data-cm="open" data-id="${this.esc(c.id)}"><span class="cm-row-title">${this.esc(c.title)}</span><span class="cm-row-facts">${c.state === 'dropped' ? 'Ignored' : 'Done'}${c.doneAt ? ` · ${this.esc(this.dayWord(String(c.doneAt).slice(0, 10), today))}` : ''}</span></button></div>`).join('')}</section>` : ''}
            ${!all.length ? '<p class="cm-empty">Nothing yet. Write what you will do above, the way you would say it.</p>' : ''}`;
    },

    captureHtml(parent) {
        const busy = this._capturing && this._capturing.parent === parent;
        return `<form class="cm-capture" data-parent="${this.esc(parent || '')}">
            <input type="text" name="text" autocomplete="off" placeholder="${parent ? 'Add a step…' : 'What will you do? Or tell me what to change'}" ${busy ? 'disabled' : ''} aria-label="${parent ? 'Add a step' : 'Add a commitment, or say what to change'}">
            <button type="submit" class="cm-capture-go" ${busy ? 'disabled' : ''}>${busy ? 'Reading…' : 'Add'}</button>
        </form>`;
    },

    proposalsHtml(parent = null) {
        const p = this._proposals;
        if (!p || (p.parent || null) !== parent) return '';
        const today = Commitments.today();
        const all = Commitments.all();
        const chips = f => {
            const c = { ...Commitments.blank('x', ''), ...f };
            return [this.whenWord(c, today), this.repeatWord(c), c.by ? `by ${this.dayWord(c.by, today)}` : '', this.remindWord(c) ? `remind ${this.remindWord(c).toLowerCase()}` : '',
                c.parent ? (all.find(x => x.id === c.parent) || {}).title : '', c.waitingOn ? `waiting on ${c.waitingOn.who}` : '', c.outcome ? 'a bigger goal' : '']
                .filter(Boolean).map(t => `<span class="cm-chip is-static">${this.esc(t)}</span>`).join('');
        };
        // A proposed change to one they already have: what would change, in words.
        const changeChips = it => {
            const cur = Commitments.get(it.id) || Commitments.blank('x', '');
            const c = { ...cur, ...it.fields }, f = it.fields;
            const words = it.op === 'done' ? ['mark done'] : it.op === 'drop' ? ['ignore'] : [
                f.title ? `rename to “${f.title}”` : '', f.when ? `move to ${this.whenWord(c, today)}` : '', f.by ? `by ${this.dayWord(f.by, today)}` : '',
                f.waitingOn ? `waiting on ${f.waitingOn.who}` : ''];
            return words.filter(Boolean).map(t => `<span class="cm-chip is-static">${this.esc(t)}</span>`).join('');
        };
        const isChange = it => it.kind === 'change';
        return `<div class="cm-proposals" role="group" aria-label="What nenva understood">
            ${p.guessed ? '<p class="cm-note">Read without the assistant, so this is a guess. Check it.</p>' : ''}
            ${p.items.map((it, i) => `<div class="cm-proposal">
                <div class="cm-proposal-main"><span class="cm-row-title">${this.esc(isChange(it) ? it.title : it.fields.title)}</span><span class="cm-chips">${isChange(it) ? changeChips(it) : chips(it.fields)}</span>
                ${it.dropped && it.dropped.length ? `<span class="cm-note">Left out (not clear): ${this.esc(it.dropped.join(', '))}</span>` : ''}</div>
                <div class="cm-proposal-acts"><button type="button" class="cm-btn is-primary" data-cm="accept" data-i="${i}">${!isChange(it) ? 'Add' : it.op === 'done' ? 'Done' : it.op === 'drop' ? 'Ignore' : 'Change'}</button><button type="button" class="cm-link" data-cm="discard" data-i="${i}">Skip</button></div>
            </div>`).join('')}
            ${p.items.length > 1 ? `<div class="cm-proposal-all"><button type="button" class="cm-btn" data-cm="accept-all">${p.items.some(isChange) ? 'Do all' : 'Add all'}</button></div>` : ''}
        </div>`;
    },

    chipHtml(id, label, value, empty) {
        return `<button type="button" class="cm-chip${value ? '' : ' is-empty'}${this._editing === id ? ' is-on' : ''}" data-cm="edit" data-field="${id}"><span class="cm-chip-label">${label}</span>${this.esc(value || empty)}</button>`;
    },

    editorHtml(c) {
        const f = this._editing;
        if (!f) return '';
        const w = c.when || {};
        const bigs = Commitments.all().filter(x => x.id !== c.id && x.state === 'open' && this.isBig(x, Commitments.all()) && !Commitments._isUnder(Commitments._load().items, x.id, c.id));
        let body = '';
        if (f === 'when') body = `<input type="date" name="date" value="${this.esc(w.date || '')}"> <input type="time" name="time" value="${this.esc(w.time || '')}"> <span class="cm-note">to</span> <input type="time" name="end" value="${this.esc(w.end || '')}">`;
        if (f === 'repeat') body = `<select name="rule">${Commitments.RULES.map(r => `<option value="${r}" ${c.repeat.rule === r ? 'selected' : ''}>${({ none: 'Does not repeat', daily: 'Every day', weekdays: 'Weekdays', weekly: 'Weekly', monthly: 'Every month', yearly: 'Every year', custom: 'Some days' })[r]}</option>`).join('')}</select>
            <span class="cm-days" ${c.repeat.rule === 'weekly' || c.repeat.rule === 'custom' ? '' : 'hidden'}>${this.DAYS.map((d, i) => `<label><input type="checkbox" name="day" value="${i}" ${(c.repeat.days || []).includes(i) ? 'checked' : ''}>${d}</label>`).join('')}</span>`;
        if (f === 'remind') {
            const cur = c.remind ? (c.remind.minutesBefore != null ? `m${c.remind.minutesBefore}` : (c.remind.daysBefore || []).length ? `d${c.remind.daysBefore[0]}` : '') : '';
            const opts = [['', 'No reminder'], ['m0', 'At the start'], ['m10', '10 minutes before'], ['m30', '30 minutes before'], ['m60', '1 hour before'], ['d1', '1 day before'], ['d2', '2 days before'], ['d7', '1 week before']];
            body = `<select name="remind">${opts.map(([v, t]) => `<option value="${v}" ${cur === v ? 'selected' : ''}>${t}</option>`).join('')}</select>`;
        }
        if (f === 'parent') body = `<select name="parent"><option value="">Not part of anything bigger</option>${bigs.map(b => `<option value="${this.esc(b.id)}" ${c.parent === b.id ? 'selected' : ''}>${this.esc(b.title)}</option>`).join('')}</select>`;
        if (f === 'waiting') body = `<input type="text" name="who" placeholder="Who is it waiting on?" value="${this.esc(c.waitingOn ? c.waitingOn.who : '')}">`;
        if (f === 'by') body = `<input type="date" name="by" value="${this.esc(c.by || '')}">`;
        if (f === 'outcome') body = `<input type="text" name="outcome" placeholder="What does done look like?" value="${this.esc(c.outcome || '')}">`;
        return `<form class="cm-editor" data-field="${f}">${body}
            <button type="submit" class="cm-btn is-primary">Save</button><button type="button" class="cm-link" data-cm="edit-cancel">Cancel</button></form>`;
    },

    /** The facts in one line (tap it to change them). Pure over the record. */
    factsSummary(c, today, all) {
        const big = this.isBig(c, all);
        const kids = all.filter(k => k.parent === c.id);
        const bits = [];
        const w = this.whenWord(c, today);
        if (w) bits.push(Commitments.repeats(c) ? `${this.repeatWord(c)}, next ${w}` : (c.when && c.when.time ? w : `Due ${w}`));
        if (c.by) bits.push(`by ${this.dayWord(c.by, today)}`);
        if (big && kids.length) bits.push(`${kids.filter(k => k.state === 'done').length} of ${kids.length} steps done`);
        const rm = this.remindWord(c); if (rm) bits.push(`reminder ${rm.toLowerCase()}`);
        if (c.waitingOn) bits.push(`waiting on ${c.waitingOn.who}`);
        return bits.join(' · ') || 'No day set';
    },

    /** nenva's one line: what it arranged (with Undo), else its read with at most one move. */
    agentHtml(c, today, all) {
        if (this._planning === c.id) return '<div class="cm-agent"><span class="cm-agent-who">nenva</span><p>Looking at your days…</p></div>';
        const note = typeof WorkPlans !== 'undefined' && WorkPlans.noteFor ? WorkPlans.noteFor(c.id) : null;
        if (note) return `<div class="cm-agent"><span class="cm-agent-who">nenva</span><p>${this.esc(note)}</p><button type="button" class="cm-link" data-cm="unarrange">Undo</button></div>`;
        // A suggestion waits for the person (2026-10-08): one button, Not
        // needed, and other times through the chat box below.
        const p = typeof WorkPlans !== 'undefined' && WorkPlans.proposalFor ? WorkPlans.proposalFor(c.id) : null;
        if (p) {
            const ss = p.plan.sessions;
            return `<div class="cm-agent"><span class="cm-agent-who">nenva</span><p>I'd set aside time for this before it's due${p.plan.why ? ` (${this.esc(p.plan.why)})` : ''}. Other times? Tell me below.</p>
                <ul class="cm-sessions">${ss.map(x => `<li>${this.esc(this.dayWord(x.date, today))} ${this.esc(this.timeWord(x.time))}, ${x.minutes} min: ${this.esc(x.what)}</li>`).join('')}</ul>
                <button type="button" class="cm-btn is-primary" data-cm="plan-accept">${ss.length === 1 ? 'Schedule 1 session' : `Schedule ${ss.length} sessions`}</button>
                <button type="button" class="cm-link" data-cm="plan-decline">Not needed</button></div>`;
        }
        const r = Commitments.shownRead(c, all, today);
        if (!r || !r.why) return '';
        return `<div class="cm-agent is-${this.esc(r.stance.replace('?', ''))}"><span class="cm-agent-who">nenva</span><p>${this.esc(r.why)}</p>
            ${r.offer ? `<button type="button" class="cm-btn" data-cm="offer" data-id="${this.esc(c.id)}">${this.esc(this.offerLabel(r.offer, today))}</button>` : ''}</div>`;
    },

    // ── Attached: files, text documents, links (2026-10-08) ─────────────
    //
    // ONE box does it all: type to find a file or a text document, paste a
    // link (a Notion page, a form) to attach it, Upload a file… to add a new
    // one to Documents and attach it, or drop files on the sheet. Every
    // attach and remove is a change through the one door, with Undo.

    ICONS: {
        file: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 1.5h5l3 3v10H4z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M9 1.5v3h3" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>',
        note: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 2.5h10v11H3z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M5.5 6h5M5.5 8.5h5M5.5 11h3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
        link: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6.8 9.2a2.6 2.6 0 0 0 3.7 0l2.3-2.3a2.6 2.6 0 0 0-3.7-3.7l-.9.9M9.2 6.8a2.6 2.6 0 0 0-3.7 0L3.2 9.1a2.6 2.6 0 0 0 3.7 3.7l.9-.9" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>'
    },

    /** Files and text documents the box can offer, as DocumentsPage's rows. */
    _attachables() {
        let notes = [];
        try { notes = (StorageManager.get('notes') || {}).notes || []; } catch { notes = []; }
        const docs = (typeof ReaderApp !== 'undefined' && ReaderApp._listing && ReaderApp._listing.docs) || [];
        const kindOf = typeof DocReader !== 'undefined' && DocReader.kindOf ? (p => DocReader.kindOf(p)) : null;
        if (typeof DocumentsPage !== 'undefined' && DocumentsPage.rows) return DocumentsPage.rows({ notes, docs, kindOf });
        return docs.map(d => ({ key: 'document', ref: d.id, title: d.title || d.relpath || 'Untitled', at: Date.parse(d.updatedAt || 0) || 0, fileKind: 'File' }));
    },
    /**
     * What the box offers for `query`: a link to attach when it is one, then
     * files and text documents not attached yet whose title has every word,
     * newest first. Pure over `rows` (DocumentsPage.rows' shape).
     */
    attachPicks(rows, attached, query, n = 8) {
        const link = Commitments.linkUrl(query);
        if (link) return { link: { url: link, title: Commitments.linkTitle(link), attached: (attached || []).some(x => x.kind === 'link' && x.id === link) }, items: [] };
        const have = new Set((attached || []).map(x => `${x.kind}:${x.id}`));
        const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
        const items = rows.map(r => ({ kind: r.key === 'note' ? 'note' : 'file', id: r.ref, title: r.title, sub: r.key === 'note' ? 'Text document' : (r.fileKind || 'File'), at: r.at || 0 }))
            .filter(x => !have.has(`${x.kind}:${x.id}`))
            .filter(x => { const hay = String(x.title).toLowerCase(); return words.every(w => hay.includes(w)); })
            .sort((a, b) => b.at - a.at)
            .slice(0, n);
        return { link: null, items };
    },
    attachSub(x) {
        if (x.kind === 'link') { try { return new URL(x.id).hostname.replace(/^www\./, ''); } catch { return 'Link'; } }
        if (x.kind === 'note') return 'Text document';
        const d = ((typeof ReaderApp !== 'undefined' && ReaderApp._listing && ReaderApp._listing.docs) || []).find(y => y.id === x.id);
        return d && typeof DocReader !== 'undefined' && DocReader.kindOf ? (DocReader.kindOf(d.relpath).label || 'File') : 'File';
    },
    _picks: null,   // what the box shows now, for Enter and clicks
    attachPicksHtml(c) {
        const p = this._picks = this.attachPicks(this._attachables(), c.attached, this._attachQuery);
        if (p.link) return p.link.attached ? '<p class="cm-attach-empty">That link is already attached.</p>'
            : `<button type="button" class="cm-attach-pick is-link" data-cm="attach-link">${this.ICONS.link}<span class="cm-attach-text"><span class="cm-attach-title">Attach link: ${this.esc(p.link.title)}</span><span class="cm-attach-sub">${this.esc(this.attachSub({ kind: 'link', id: p.link.url }))}</span></span></button>`;
        if (!p.items.length) return `<p class="cm-attach-empty">${this._attachQuery ? 'Nothing matches. Paste a link, or upload a file.' : 'Nothing in Documents yet. Paste a link, or upload a file.'}</p>`;
        return p.items.map((x, i) => `<button type="button" class="cm-attach-pick" data-cm="attach-pick" data-i="${i}">${this.ICONS[x.kind]}<span class="cm-attach-text"><span class="cm-attach-title">${this.esc(x.title)}</span><span class="cm-attach-sub">${this.esc(x.sub)}</span></span></button>`).join('');
    },
    _drawAttachPicks() {
        const host = document.querySelector('#commitments-view .cm-attach-picks');
        const c = this._open && Commitments.get(this._open);
        if (host && c) host.innerHTML = this.attachPicksHtml(c);
    },
    attachedHtml(c) {
        const list = Array.isArray(c.attached) ? c.attached : [];
        const can = typeof window !== 'undefined';
        if (!list.length && !this._attaching) return can ? '<button type="button" class="cm-link cm-attach-open" data-cm="attach-open">Attach</button>' : '';
        return `<section class="cm-attached">${list.length ? '<h2 class="cm-eyebrow">Attached</h2>' : ''}
            ${list.map((x, i) => `<div class="cm-attached-row">
                <button type="button" class="cm-attached-main" data-cm="attached-open" data-i="${i}" title="${this.esc(x.kind === 'link' ? x.id : x.title)}">${this.ICONS[x.kind] || this.ICONS.file}<span class="cm-attach-text"><span class="cm-attach-title">${this.esc(x.title || 'Untitled')}</span><span class="cm-attach-sub">${this.esc(this.attachSub(x))}</span></span></button>
                <button type="button" class="cm-link cm-attached-remove" data-cm="attached-remove" data-i="${i}" aria-label="Remove ${this.esc(x.title || '')}">Remove</button></div>`).join('')}
            ${this._attaching ? `<div class="cm-attach-box">
                <input type="text" class="cm-attach-input" placeholder="Find a document, or paste a link" aria-label="Find a document, or paste a link" autocomplete="off" value="${this.esc(this._attachQuery || '')}">
                <div class="cm-attach-picks">${this.attachPicksHtml(c)}</div>
                <div class="cm-attach-foot">${window.electronLibrary ? '<button type="button" class="cm-link" data-cm="attach-upload">Upload a file…</button><span class="cm-attach-hint">or drop files here</span>' : ''}<button type="button" class="cm-link" data-cm="attach-close">Done</button></div></div>`
                : '<button type="button" class="cm-link cm-attach-open" data-cm="attach-open">Attach</button>'}</section>`;
    },
    /** Add to the open commitment, with Undo. `items`: [{kind, id, title}]. */
    attachItems(items, { close = true } = {}) {
        const c = this._open && Commitments.get(this._open);
        if (!c || !items.length) return;
        const cur = Array.isArray(c.attached) ? c.attached : [];
        const fresh = items.filter(x => !cur.some(y => y.kind === x.kind && y.id === x.id));
        if (close) { this._attaching = false; this._attachQuery = ''; }
        if (!fresh.length) { this.render(); return; }
        const r = Commitments.change(c.id, { attached: [...cur, ...fresh] });
        this.render();
        if (r.ok && r.ledgerId) this.toast(fresh.length === 1 ? `Attached: ${fresh[0].title}` : `Attached ${fresh.length}`, r.ledgerId);
    },
    /** Files picked or dropped: copied into Documents (D1), then attached. */
    _attachImported(res) {
        if (!res || res.canceled) return;
        if (res.error) { if (typeof UIUtils !== 'undefined') UIUtils.showToast(String(res.error), 'error'); return; }
        const docs = res.docs || [];
        if (!docs.length) { if (typeof UIUtils !== 'undefined') UIUtils.showToast(res.skipped ? 'That kind of file can\'t be kept in Documents' : 'Nothing was added', 'info'); return; }
        if (typeof ReaderApp !== 'undefined' && ReaderApp.cacheListing) ReaderApp.cacheListing().catch(() => {});
        this.attachItems(docs.map(d => ({ kind: 'file', id: d.id, title: String(d.relpath || d.title || '').split('/').pop() || 'Untitled' })));
    },
    _wireAttachDrop(page) {
        const files = e => !!this._open && Array.from(e.dataTransfer?.types || []).includes('Files') && !!window.electronLibrary;
        page.addEventListener('dragover', e => { if (!files(e)) return; e.preventDefault(); page.classList.add('is-dragover'); });
        page.addEventListener('dragleave', e => { if (!page.contains(e.relatedTarget)) page.classList.remove('is-dragover'); });
        page.addEventListener('drop', async e => {
            page.classList.remove('is-dragover');
            if (!files(e)) return;
            e.preventDefault();
            const paths = Array.from(e.dataTransfer.files || []).map(f => { try { return window.electronLibrary.pathForFile(f); } catch { return null; } }).filter(Boolean);
            if (!paths.length) return;
            try { this._attachImported(await window.electronLibrary.importPaths(paths)); } catch { /* nothing landed */ }
        });
    },

    /** What the person said about particular days (Commitments.report), newest first. */
    logHtml(c, today) {
        const days = Object.keys(c.log || {}).sort().reverse().slice(0, 5);
        if (!days.length) return '';
        const mark = d => { const h = c.history && c.history[d]; return h === 'done' ? 'done' : h === 'dropped' ? 'skipped' : ''; };
        return `<section class="cm-log"><h2 class="cm-eyebrow">What you said</h2>${days.map(d => `<div class="cm-log-row">
            <span class="cm-log-day">${this.esc(this.dayWord(d, today))}${mark(d) ? ` · ${mark(d)}` : ''}</span>
            <span class="cm-log-text">${c.log[d].map(e => this.esc(e.quote)).join('<br>')}</span></div>`).join('')}</section>`;
    },

    /** Where this came from, by the record's own origin: { label, about, door, messageId | url } or null. Pure but for the lookups. */
    originOf(c) {
        const o = (c && c.origin) || {};
        if (o.kind === 'matter' && typeof Matters !== 'undefined') {
            const m = Matters.get(o.ref);
            const last = m ? Matters.messagesOf(m).pop() : null;
            if (!m) return null;
            const text = !!last && (last.kind === 'imessage' || /^imsg:/.test(String(last.id)));
            // The folder is the door (2026-10-07): its page holds every message with its own way to Gmail.
            return { label: last ? (text ? 'From a text' : 'From an email') : 'From', about: Matters.titleOf(m), messageId: last ? last.id : null, text, matterId: m.id };
        }
        if ((o.kind === 'email' || o.kind === 'text') && o.ref) return { label: o.kind === 'text' ? 'From a text' : 'From an email', about: o.subject || o.from || '', messageId: o.ref, text: o.kind === 'text' };
        if (o.kind === 'news' && o.ref) return { label: 'From the news', about: o.title || '', url: o.ref };
        if (o.kind === 'apple') return { label: 'From Apple Reminders', about: o.list || '' };
        return null;
    },
    originHtml(c) {
        const o = this.originOf(c);
        if (!o) return '';
        const door = o.url ? 'Open article' : o.matterId && typeof MatterPage !== 'undefined' ? 'See it' : !o.messageId ? '' : o.text ? 'Open conversation'
            : (typeof EmailApp !== 'undefined' && EmailApp.openMessageLabel ? EmailApp.openMessageLabel(o.messageId) : 'Open email');
        return `<p class="cm-origin">${this.esc(o.label)}${o.about ? `: ${this.esc(o.about)}` : ''}${door ? ` · <button type="button" class="cm-link" data-cm="origin">${this.esc(door)}</button>` : ''}</p>`;
    },

    sheetHtml(c) {
        const all = Commitments.all();
        const today = Commitments.today();
        const big = this.isBig(c, all);
        const kids = all.filter(k => k.parent === c.id).sort((a, b) => (((a.when && a.when.date) || '9999') + ((a.when && a.when.time) || '')).localeCompare(((b.when && b.when.date) || '9999') + ((b.when && b.when.time) || '')));
        const parent = c.parent ? all.find(x => x.id === c.parent) : null;
        const resolved = c.state === 'done' || c.state === 'dropped';
        const doneToday = Commitments.repeats(c) && Commitments.isDone(c, today);
        const step = k => `<div class="cm-step${k.state !== 'open' ? ' is-done' : ''}">
            ${k.state === 'open' ? `<button type="button" class="cm-check" data-cm="done" data-id="${this.esc(k.id)}" aria-label="Mark ${this.esc(k.title)} done"></button>` : '<span class="cm-check is-on" aria-hidden="true"></span>'}
            <span class="cm-step-when">${this.esc(this.whenWord(k, today) || '')}</span>
            <button type="button" class="cm-step-title" data-cm="open" data-id="${this.esc(k.id)}">${this.esc(k.title)}</button></div>`;
        return `<button type="button" class="back-link cm-back" data-cm="back">‹ ${parent ? this.esc(parent.title) : this.LABEL}</button>
            <article class="cm-sheet">
                <div class="cm-sheet-head">
                    <form class="cm-title-form"><input class="cm-title-input" name="title" value="${this.esc(c.title)}" aria-label="Title"></form>
                    ${resolved ? `<button type="button" class="cm-btn" data-cm="reopen">${c.state === 'dropped' ? 'Ignored' : 'Done'} · Reopen</button>`
                        : `<button type="button" class="cm-btn is-primary" data-cm="done" data-id="${this.esc(c.id)}">${doneToday ? 'Done today ✓' : 'Done'}</button>`}
                </div>
                <button type="button" class="cm-facts" data-cm="facts" aria-expanded="${!!this._details}">${this.esc(this.factsSummary(c, today, all))}</button>
                ${this._details ? `<div class="cm-chips">
                    ${big ? '' : `${this.chipHtml('when', 'When', this.whenWord(c, today), 'Add a day')}
                    ${this.chipHtml('repeat', 'Repeats', this.repeatWord(c), 'No')}
                    ${this.chipHtml('remind', 'Remind', this.remindWord(c), 'No')}`}
                    ${this.chipHtml('by', 'By', c.by ? this.dayWord(c.by, today) : '', 'No deadline')}
                    ${this.chipHtml('parent', 'Part of', parent ? parent.title : '', 'Nothing bigger')}
                    ${this.chipHtml('waiting', 'Waiting on', c.waitingOn ? c.waitingOn.who : '', 'No one')}
                    ${big || c.outcome ? this.chipHtml('outcome', 'Done looks like', c.outcome || '', 'Say what done is') : ''}
                </div>${this.editorHtml(c)}` : ''}
                ${this.originHtml(c)}
                ${this.agentHtml(c, today, all)}
                ${kids.length || this._addingStep ? `<section class="cm-steps">${kids.length ? `<div class="cm-steps-head">${this.completedToggleHtml()}</div>` : ''}${kids.filter(k => this._showDone || k.state === 'open').map(step).join('')}
                    ${this._addingStep ? `${this.captureHtml(c.id)}${this.proposalsHtml(c.id)}` : ''}</section>` : ''}
                ${this._addingStep ? '' : '<button type="button" class="cm-link cm-add-step" data-cm="add-step">Add a step</button>'}
                ${this.attachedHtml(c)}
                ${c.note || this._noting ? `<textarea class="cm-note-input" name="note" rows="3" placeholder="Anything worth keeping">${this.esc(c.note || '')}</textarea>` : ''}
                ${this.logHtml(c, today)}
                ${this.sheetChatHtml(c)}
                <div class="cm-more">
                    ${resolved ? '' : '<button type="button" class="cm-link" data-cm="drop">Ignore</button>'}
                    ${c.note ? '' : '<button type="button" class="cm-link" data-cm="note">Add a note</button>'}
                    <button type="button" class="cm-link cm-danger" data-cm="remove">Delete</button>
                </div>
            </article>`;
    },

    // ── Acting (every write: the one door, by you, with Undo) ───────────

    toast(msg, ledgerId) {
        if (typeof UIUtils === 'undefined') return;
        UIUtils.showToast(msg, 'success', 6000, ledgerId ? { actionLabel: 'Undo', onAction: () => { Commitments.undo(ledgerId); this.render(); } } : undefined);
    },

    onClick(e) {
        const el = e.target.closest('[data-cm]');
        if (!el) return;
        const act = el.dataset.cm;
        const id = el.dataset.id || this._open;
        const c = id ? Commitments.get(id) : null;
        if (act === 'open') { this._open = el.dataset.id; this._editing = null; this._proposals = null; this._details = false; this._addingStep = false; this._noting = false; this._attaching = false; this._attachQuery = ''; this.render(); window.scrollTo?.(0, 0); return; }
        if (act === 'attach-open') {
            this._attaching = true; this._attachQuery = ''; this.render();
            document.querySelector('#commitments-view .cm-attach-input')?.focus();
            // A fresh listing, in case files landed since the cache was filled.
            if (typeof ReaderApp !== 'undefined' && ReaderApp.cacheListing && window.electronLibrary) ReaderApp.cacheListing().then(() => this._drawAttachPicks()).catch(() => {});
            return;
        }
        if (act === 'attach-close') { this._attaching = false; this._attachQuery = ''; this.render(); return; }
        if (act === 'attach-pick') { const x = this._picks && this._picks.items[Number(el.dataset.i)]; if (x) this.attachItems([x]); return; }
        if (act === 'attach-link') { const l = this._picks && this._picks.link; if (l) this.attachItems([{ kind: 'link', id: l.url, title: l.title }]); return; }
        if (act === 'attach-upload') { (async () => { try { this._attachImported(await window.electronLibrary.importFiles()); } catch { /* cancelled */ } })(); return; }
        if (act === 'attached-open') {
            const x = c && (c.attached || [])[Number(el.dataset.i)];
            if (!x) return;
            if (x.kind === 'link') { AppManager.openExternal(x.id); return; }
            if (typeof DocumentsPage !== 'undefined' && DocumentsPage.showDocument(x.kind === 'note' ? 'note' : 'file', x.id)) return;
            if (x.kind === 'file' && typeof RecordLinks !== 'undefined' && RecordLinks.open) RecordLinks.open('document', x.id);
            return;
        }
        if (act === 'unarrange' && this._open && typeof WorkPlans !== 'undefined') {
            const n = WorkPlans.unarrange(this._open); this.render();
            if (typeof UIUtils !== 'undefined') UIUtils.showToast(n ? `Removed ${n} planned session${n === 1 ? '' : 's'}; I won't plan this one again` : 'Nothing to undo', 'success');
            return;
        }
        if (act === 'to-memory') { SimpleSettings.open('memory'); return; }
        if (act === 'back') { this._open = c && c.parent && Commitments.get(c.parent) ? c.parent : null; this._editing = null; this._proposals = null; this._details = false; this._addingStep = false; this.render(); return; }
        if (act === 'toggle-done') {
            this._showDone = !this._showDone;
            this.render();
            document.querySelector('#commitments-view [data-cm="toggle-done"]')?.focus({ preventScroll: true });
            return;
        }
        if (act === 'edit') { this._editing = this._editing === el.dataset.field ? null : el.dataset.field; this.render(); return; }
        if (act === 'edit-cancel') { this._editing = null; this.render(); return; }
        if (act === 'accept' || act === 'accept-all') { this.accept(act === 'accept' ? Number(el.dataset.i) : null); return; }
        if (act === 'discard') { this._proposals.items.splice(Number(el.dataset.i), 1); if (!this._proposals.items.length) this._proposals = null; this.render(); return; }
        if (act === 'chat' && c && typeof SimpleExperience !== 'undefined') {
            SimpleExperience.openChatFor({ key: `task:${c.id}`, title: c.title, body: this.factsLine(c, Commitments.today(), Commitments.all()).replace(/<[^>]+>/g, ''), row: { kind: 'task', id: c.id } });
            return;
        }
        if (!c) return;
        if (act === 'origin') {
            const o = this.originOf(c);
            if (o && o.url && typeof AppManager !== 'undefined') AppManager.openExternal(o.url);
            else if (o && o.matterId && typeof MatterPage !== 'undefined' && MatterPage.open(o.matterId)) return;
            else if (o && o.messageId && typeof EmailApp !== 'undefined') EmailApp.openMessageFrom(o.messageId);
            return;
        }
        if (act === 'offer') { this.takeOffer(c); return; }
        if (act === 'attached-remove') {
            const cur = Array.isArray(c.attached) ? c.attached : [];
            const x = cur[Number(el.dataset.i)];
            if (!x) return;
            const r = Commitments.change(c.id, { attached: cur.filter(y => y !== x) });
            this.render();
            if (r.ok && r.ledgerId) this.toast(`Removed: ${x.title || 'attachment'}`, r.ledgerId);
            return;
        }
        if (act === 'plan-accept' && typeof WorkPlans !== 'undefined') { const n = WorkPlans.accept(c.id); this.render(); if (n && typeof UIUtils !== 'undefined') UIUtils.showToast(`Scheduled ${n} session${n === 1 ? '' : 's'}`, 'success'); return; }
        if (act === 'plan-talk' && typeof WorkPlans !== 'undefined') { WorkPlans.talk(c.id); return; }
        if (act === 'plan-decline' && typeof WorkPlans !== 'undefined') { WorkPlans.decline(c.id); this.render(); return; }
        let r = null, msg = '';
        if (act === 'done') {
            const today = Commitments.today();
            if (Commitments.repeats(c) && Commitments.isDone(c, today)) { r = Commitments.reopen(c.id); msg = `Not done today: ${c.title}`; }
            else { r = Commitments.resolve(c.id, 'done'); msg = `Done: ${c.title}`; }
        }
        if (act === 'drop') { r = Commitments.resolve(c.id, 'dropped'); msg = `Ignored: ${c.title}`; }
        if (act === 'reopen') { r = Commitments.reopen(c.id); msg = `Reopened: ${c.title}`; }
        if (act === 'remove') { r = Commitments.remove(c.id); msg = `Deleted: ${c.title}`; if (r.ok && this._open === c.id) this._open = c.parent || null; }
        if (r && r.ok) { this.render(); if (r.ledgerId) this.toast(msg, r.ledgerId); }
        else if (r && typeof UIUtils !== 'undefined') UIUtils.showToast(r.error || 'Not changed', 'error');
    },

    /** The person tapped the assistant's offer (C4: the tap is the yes). */
    takeOffer(c) {
        const o = c.read && c.read.offer;
        if (!o) return;
        let r = null, msg = '';
        if (o.kind === 'move') { r = Commitments.change(c.id, { when: { ...(c.when || {}), date: o.date } }, { why: 'nenva offered' }); const w = this.dayWord(o.date, Commitments.today()); msg = `Moved to ${/^(Today|Tomorrow)$/.test(w) ? w.toLowerCase() : w}: ${c.title}`; }
        else if (o.kind === 'done') { r = Commitments.resolve(c.id, 'done', { why: 'nenva offered' }); msg = `Done: ${c.title}`; }
        else if (o.kind === 'drop') { r = Commitments.resolve(c.id, 'dropped', { why: 'nenva offered' }); msg = `Let go: ${c.title}`; }
        else if (o.kind === 'prepare' && typeof WorkPlans !== 'undefined' && WorkPlans.planFor) {
            // The work-plan engine plans it (free time, the calendar, the
            // person's rhythm); the sessions show on the sheet to accept.
            this._open = c.id; this._planning = c.id;
            if (AppManager.currentApp !== 'commitments') AppManager.openAppFromLauncher('commitments');
            this.render();
            WorkPlans.planFor(c.id).then(res => {
                this._planning = null;
                if (res && res.error) {
                    if (typeof UIUtils !== 'undefined') UIUtils.showToast(res.error, 'info');
                    this.talk(c, this.offerPrompt(o, c));
                    return;
                }
                this.render();
            }).catch(() => { this._planning = null; this.render(); });
            return;
        }
        else { this.talk(c, this.offerPrompt(o, c)); return; }
        if (r && r.ok) { this.render(); if (r.ledgerId) this.toast(msg, r.ledgerId); }
    },

    async onSubmit(e) {
        e.preventDefault();
        const form = e.target;
        if (form.classList.contains('cm-capture')) {
            const text = String(new FormData(form).get('text') || '').trim();
            if (!text) return;
            const parent = form.dataset.parent || null;
            this._capturing = { parent };
            this._proposals = null;
            this.render();
            const res = await Commitments.capture(text, { parent });
            this._capturing = null;
            // Without PageChat this is also the page's own box: a question goes to the chat panel.
            if (res.ask && typeof AgentUI !== 'undefined' && AgentUI.askWithPrompt) { this.render(); AgentUI.askWithPrompt(text, { newChat: true }); return; }
            this._proposals = res.proposals.length ? { parent, items: res.proposals, guessed: !!res.guessed } : null;
            this.render();
            return;
        }
        if (form.classList.contains('cm-title-form')) { this.saveField('title', { title: form.title.value }); form.querySelector('input').blur(); return; }
        if (form.classList.contains('cm-editor')) {
            const c = Commitments.get(this._open);
            if (!c) return;
            const fd = new FormData(form);
            const f = form.dataset.field;
            let input = null;
            if (f === 'when') { const date = fd.get('date') || null, time = fd.get('time') || null; input = { when: date || time ? { date, time, end: time ? (fd.get('end') || null) : null } : null }; }
            if (f === 'repeat') {
                const rule = fd.get('rule');
                let days = fd.getAll('day').map(Number);
                if ((rule === 'weekly' || rule === 'custom') && !days.length) {
                    const anchor = c.when && c.when.date ? new Date(`${c.when.date}T12:00:00`) : new Date();
                    days = [anchor.getDay()];
                }
                input = { repeat: { rule, days } };
                if (rule !== 'none' && !(c.when && c.when.date)) input.when = { date: Commitments.today(), time: c.when ? c.when.time : null, end: c.when ? c.when.end : null };
            }
            if (f === 'remind') { const v = fd.get('remind'); input = { remind: !v ? null : v[0] === 'm' ? { minutesBefore: Number(v.slice(1)), daysBefore: [] } : { minutesBefore: null, daysBefore: [Number(v.slice(1))] } }; }
            if (f === 'parent') input = { parent: fd.get('parent') || null };
            if (f === 'waiting') input = { waitingOn: fd.get('who') ? { who: fd.get('who') } : null };
            if (f === 'by') input = { by: fd.get('by') || null };
            if (f === 'outcome') input = { outcome: fd.get('outcome') || null };
            this._editing = null;
            this.saveField(f, input);
        }
    },

    onChange(e) {
        if (e.target.matches('.cm-editor select[name="rule"]')) {
            const days = e.target.form.querySelector('.cm-days');
            if (days) days.hidden = !['weekly', 'custom'].includes(e.target.value);
            return;
        }
        if (e.target.classList.contains('cm-note-input')) this.saveField('note', { note: e.target.value }, { quiet: true });
        if (e.target.classList.contains('cm-title-input')) this.saveField('title', { title: e.target.value });
    },

    saveField(field, input, { quiet = false } = {}) {
        const c = Commitments.get(this._open);
        if (!c || !input) return;
        const r = Commitments.change(c.id, input);
        if (!r.ok) { if (typeof UIUtils !== 'undefined') UIUtils.showToast(r.error, 'error'); return; }
        if (r.dropped.length && typeof UIUtils !== 'undefined') UIUtils.showToast('That date or time is not valid; nothing changed there.', 'warning');
        this.render();
        if (r.changed.length && !quiet) this.toast(`Changed: ${c.title}`, r.ledgerId);
    },

    accept(i) {
        const p = this._proposals;
        if (!p) return;
        const take = i == null ? p.items.slice() : [p.items[i]];
        let last = null, made = 0;
        let word = 'Added';
        for (const it of take) {
            // The tap is the yes (C4); a change goes through the same door.
            const r = it.kind !== 'change' ? Commitments.create(it.fields, { by: 'you', origin: { kind: 'you' } })
                : it.op === 'done' ? Commitments.resolve(it.id, 'done', { why: 'you said so' })
                : it.op === 'drop' ? Commitments.resolve(it.id, 'dropped', { why: 'you said so' })
                : Commitments.change(it.id, it.fields, { why: 'you said so' });
            if (r.ok) { made++; last = r; word = it.kind !== 'change' ? 'Added' : it.op === 'done' ? 'Done' : it.op === 'drop' ? 'Ignored' : 'Changed'; }
        }
        if (i == null) this._proposals = null;
        else { p.items.splice(i, 1); if (!p.items.length) this._proposals = null; }
        this.render();
        if (made && last) this.toast(made === 1 ? `${word}: ${take[0].title || take[0].fields.title}` : (take.some(it => it.kind === 'change') ? `Did ${made}` : `Added ${made}`), made === 1 ? last.ledgerId : null);
        this._focusCapture = !this._proposals;
    }
};

if (typeof module !== 'undefined') module.exports = CommitmentsPage;
