/**
 * Threads (2026-10-10, an experiment, by request; THE HOME PAGE since
 * 2026-10-11): nenva told as a Messages app. Every folder nenva keeps
 * (Matters) is a SENDER; its thread is everything about that thing in time
 * order, and nenva speaks to the person through it, the way an assistant
 * texts you about the dentist, the water bill or the cake order.
 *
 * Home (2026-10-11, Ram: "retire the now page and make Threads page the
 * home page"): the app opens here (AppManager.showDashboard lands here, the
 * name in the titlebar and every "home" door come here), on nenva's thread
 * first. The day Now used to show, Today and Coming up, is the top of
 * nenva's thread (`dayHtml`, from SimpleExperience.schedule: facts and
 * TodayHelp's one line per row, nothing else model-written), folded on
 * every visit like it was on Now.
 *
 * Nothing new is stored and nothing here is model-written at render:
 *   - the mail and texts filed on the folder, its log (the calendar moved,
 *     a join), and where it stands now are code-written bubbles from the
 *     folder's own fields;
 *   - the folder's open Now card, if it has one, is the newest bubble, with
 *     the card's own buttons as reply chips (SimpleExperience.cardAct, so
 *     a tap here is exactly a tap on Now);
 *   - what the person types goes into the folder's ONE chat (the
 *     `matter:<id>` conversation Now's card and the folder page already
 *     use, SimpleExperience._cardConv), marked `texting` so the assistant
 *     answers in a line or two (AgentService.TEXTING_STYLE). No streaming:
 *     a typing bubble until the whole reply lands.
 *
 * SENDERS (docs/SENDERS.md M2, 2026-10-10): a thread is a SENDER, one
 * long-lived thing in the person's life (Auto insurance, Your dental), and
 * its timeline is the union of everything in it: the folders and the
 * commitments placed there (Senders.members), each one's own chat as it
 * was, and the sender's ONE conversation (`todayKey` = the sender id). The
 * nenva sender is pinned first. A folder or commitment no sender holds yet
 * still shows as its own thread, which is what Threads did before senders.
 * A new sender says so in its first bubble, with Keep / Rename / Fold into
 * as one-tap answers, until the person confirms it (S3).
 *
 * Unread and hidden are synced on the senders record (S8; this Mac's old
 * `threads-seen` / `threads-hidden` are carried over once): a thread is
 * unread when something happened on it after it was last opened.
 *
 * Pure parts (timeline, preview, timeLabel) are Node-testable.
 */
const ThreadsPage = {
    ...(typeof module !== 'undefined' && module.exports ? require('../shared/thread-core') : ThreadCore),
    APP: 'threads',
    SEEN_KEY: 'threads-seen',
    HIDDEN_KEY: 'threads-hidden',
    UNDO_MS: 7000,
    CLOCK_LOOK_MS: 60 * 1000,
    RECENT_DAYS: 14,
    _open: null,
    _query: '',
    _mounted: false,
    _sending: new Set(),
    _paint: {},

    esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); },

    // Shared timeline/calendar rules live in js/shared; the adapters below
    // read desktop stores and connect their results to the renderer.

    commitmentFacts(c, today, parentTitle = '', all = null) {
        const bits = [];
        // What it is, said as itself (2026-10-11, CommitmentKinds).
        if (typeof CommitmentKinds !== 'undefined') bits.push(CommitmentKinds.label(c, all || undefined));
        if (parentTitle) bits.push(`Part of ${parentTitle}`);
        const w = this.commitmentWhen(c); if (w) bits.push(w);
        if (c.by) bits.push(`by ${this._dayWords(c.by)}`);
        if (c.state !== 'open') bits.push(c.state === 'done' ? 'Done' : 'Let go');
        else if (c.when && c.when.date && c.when.date < today && !(c.repeat && c.repeat.rule && c.repeat.rule !== 'none')) bits.push('Overdue');
        return bits.join(' · ');
    },

    /**
     * What the person sees above their message, for the model (2026-10-10:
     * replies ignored the thread, because the emails, the log and nenva's
     * question are drawn by this page and were never in the conversation).
     * The same facts get_matter returns, laid out as the thread reads; the
     * chat lines are left out (the conversation already carries them).
     * Appended to the turn by AgentService for a `texting` conversation,
     * never on an untrusted turn. Returns '' when the folder is gone.
     */
    CONTEXT_ITEMS: 16,
    // The tool groups a thing's thread has from its first turn (AgentTools.GROUP_INFO names).
    THREAD_GROUPS: ['email', 'messages', 'calendar', 'commitments', 'matters', 'senders'],
    contextFor(conv) {
        if (conv && conv.pageKey === 'page:portfolio') {
            return '\n\nTHIS THREAD is "Your money": the person\'s whole money picture (accounts, holdings, property, debts, the investment plan, bank and card spending). Its drawer (the chart button) draws net worth, accounts, the plan\'s check, holdings and spending from their records; get_thread_panel reads exactly that. Read with money_overview and the portfolio tools; link a bank or brokerage with link_institution; never invent a figure.';
        }
        if (!conv || !conv.todayKey) return '';
        if (/^sender:/.test(String(conv.todayKey))) return this._senderContext(String(conv.todayKey));
        if (/^task:/.test(String(conv.todayKey))) return this._commitmentContext(String(conv.todayKey));
        if (typeof Matters === 'undefined') return '';
        const m = Matters.get(String(conv.todayKey));
        if (!m) return '';
        this._cards = null;
        const items = this.timeline(m, null, this._card(m)).slice(-this.CONTEXT_ITEMS);
        const day = t => t ? new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
        const cut = (v, n = 220) => { v = String(v || '').replace(/\s+/g, ' ').trim(); return v.length > n ? v.slice(0, n - 1) + '…' : v; };
        const step = Matters.openStep(m);
        const facts = [Matters.titleOf(m), m.kind && m.kind !== 'other' ? m.kind : '', Matters.whenText(m), m.amount && m.amount !== 'null' ? String(m.amount) : '',
            m.place || m.vendor || '', m.code ? `#${m.code}` : ''].filter(Boolean).join(' · ');
        const lines = [
            'THIS THREAD (the person is texting you in nenva\'s thread for ONE thing you keep track of for them; their message is about this thing, never ask which one. Below is what they see above their message, oldest first; the chat lines are in the conversation itself)',
            `Thing: ${cut(facts, 300)}`,
            `State: ${m.state}${m.status ? `. Where it stands: ${cut(m.status)}` : ''}`,
            step ? `Open next step: ${cut(step.what)}${step.by ? ` (by ${step.by})` : ''}${step.how && step.how !== 'none' ? ` [${step.how}]` : ''}` : '',
            m.calendar ? `On their calendar: ${cut([m.calendar.title, m.calendar.date, m.calendar.time, m.calendar.location].filter(Boolean).join(', '))}` : ''
        ].filter(Boolean);
        const rows = items.map(x => {
            if (x.kind === 'message') return `- ${day(x.at)} · ${cut(x.text)}`;
            if (x.kind === 'log') return `- ${day(x.at)} · noted: ${cut(x.text)}`;
            if (x.kind === 'now' && x.card && typeof SimpleExperience !== 'undefined') {
                const acts = SimpleExperience.cardActs(x.card).filter(a => !a.feedback).map(a => a.label);
                return `- you (nenva) asked, newest: "${cut(x.text)}"${acts.length ? ` with buttons: ${acts.join(' / ')}` : ''}`;
            }
            if (x.kind === 'status') return `- where it stands now: ${cut(x.text)}`;
            return '';
        }).filter(Boolean);
        if (rows.length) lines.push('Thread:', ...rows);
        return `\n\n${lines.join('\n')}`;
    },

    /**
     * A sender's thread for the model: what the thing is, what "all good"
     * means, every item in it with where it stands, and the thread as the
     * person sees it (each line says which item it is about).
     */
    _senderContext(id) {
        if (typeof Senders === 'undefined') return '';
        this._cards = null;
        const row = this.rowFor(id);
        if (!row || row.type !== 'sender') return '';
        const day = t => t ? new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
        const cut = (v, n = 200) => { v = String(v || '').replace(/\s+/g, ' ').trim(); return v.length > n ? v.slice(0, n - 1) + '…' : v; };
        const items = row.memberRows.map(r => {
            const kind = r.type === 'matter' ? `${(r.rec && r.rec.kind) || 'item'} from their mail or texts, id ${r.key}` : `their commitment, id ${r.key.slice(5)}`;
            return `- ${r.title} (${kind}${r.settled ? ', settled' : ''})${r.facts ? ` · ${cut(r.facts, 140)}` : ''}${this.statusOf(r.items) ? ` · now: ${cut(this.statusOf(r.items), 120)}` : ''}`;
        });
        const rows = this.events(row.items).filter(x => x.kind !== 'chat').slice(-this.CONTEXT_ITEMS).map(x => {
            const about = x.about ? `[${cut(x.about, 60)}] ` : '';
            if (x.kind === 'now' && x.card && typeof SimpleExperience !== 'undefined') {
                const acts = SimpleExperience.cardActs(x.card).filter(a => !a.feedback).map(a => a.label);
                return `- ${about}you (nenva) asked, open: "${cut(x.text)}"${acts.length ? ` with buttons: ${acts.join(' / ')}` : ''}`;
            }
            if (x.kind === 'intro') return `- you (nenva) said: "${cut(x.text)}"`;
            return `- ${day(x.at)} · ${about}${cut(x.text)}`;
        });
        const s = row.rec;
        const told = (Array.isArray(s.facts) ? s.facts : []).slice(-20).map(f => `- ${cut(f.text, 200)}`);
        // Decisions, updates, routines, documents and jobs about it, from the one reader (M8).
        const knows = typeof SenderKnows !== 'undefined' ? SenderKnows.lines(SenderKnows.of(s.id) || { decisions: [], updates: [], routines: [], documents: [], jobs: [] }) : [];
        if (s.id === Senders.REMINDERS) {
            return `\n\nTHIS THREAD (the person is texting you in nenva's Reminders thread: their list of small one-time to-dos that belong to nothing bigger. Their message is about one of these, or a new small to-do to add (add_commitment, no parent). To act on one use its id with your tools. What they say they did is filed on it by the app before your answer.)\nTo-dos in it:\n${items.join('\n') || '- (nothing yet)'}${rows.length ? `\nThread (oldest first; the chat lines are in the conversation itself):\n${rows.join('\n')}` : ''}`;
        }
        return `\n\nTHIS THREAD (the person is texting you in nenva's thread for ONE thing in their life you look after for them: "${s.name}"${s.allGood ? `. All good means: ${cut(s.allGood).replace(/[.!?]+$/, '')}` : ''}. Their message is about this thing, possibly about one item in it; never ask which thing. To act on an item use its id with your tools.${!s.confirmed ? ' You started keeping track of it yourself; if they rename it or say it belongs with another, use rename_sender or fold_senders.' : ''} Lasting facts they tell you about it are kept on it by the app after your answer; do not save them with save_memory. When they ask you to write to someone (a quote request, a question to a company), never invent an address or a name: use one the thread's messages hold, find one on the web and say where it came from, or ask them whom to write to. A sign-in anywhere is theirs to do: never ask for a password or a code, and never say you will log in for them. When one request needs several changes (a calendar series ended and another started, a reminder added), make the tool calls together in one turn so they are approved together.)\nItems in it:\n${items.join('\n') || '- (nothing yet)'}${told.length ? `\nWhat they have told you about it:\n${told.join('\n')}` : ''}${knows.length ? `\n${knows.join('\n')}` : ''}${rows.length ? `\nThread (oldest first; the chat lines are in the conversation itself):\n${rows.join('\n')}` : ''}`;
    },

    /**
     * A commitment's thread for the model: its record already rides the turn
     * (the CURRENT TASK block, recordKey `task:<id>`), so only the thread's
     * own lines are added: what changed, nenva's read, its open question.
     */
    _commitmentContext(key) {
        if (typeof Commitments === 'undefined') return '';
        const c = Commitments.get(key.slice(5));
        if (!c) return '';
        this._cards = null;
        let ledger = [];
        try { ledger = (Commitments._load().ledger || []).filter(e => e && e.target === c.id && e.by !== 'app'); } catch { ledger = []; }
        const items = this.commitmentTimeline(c, null, this._cardFor(key), ledger).slice(-this.CONTEXT_ITEMS);
        const day = t => t ? new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
        const rows = items.map(x => {
            if (x.kind === 'now' && x.card && typeof SimpleExperience !== 'undefined') {
                const acts = SimpleExperience.cardActs(x.card).filter(a => !a.feedback).map(a => a.label);
                return `- you (nenva) asked, newest: "${x.text}"${acts.length ? ` with buttons: ${acts.join(' / ')}` : ''}`;
            }
            if (x.kind === 'status') return `- where it stands now: ${x.text}`;
            if (x.kind === 'read') return `- you (nenva) said: "${x.text}"`;
            return `- ${day(x.at)} · ${x.text}`;
        });
        // A goal's thread holds its steps (2026-10-11): name them, with ids, so a message about one reaches it.
        let steps = [];
        try { steps = Commitments.family(c).slice(1).filter(k => k.state === 'open' && this._keeps(k)); } catch { steps = []; }
        if (steps.length) {
            const list = steps.slice(0, 20).map(k => `- ${k.title} (id ${k.id}${k.repeat && k.repeat.rule && k.repeat.rule !== 'none' ? `, repeats ${k.repeat.rule}` : ''})`);
            const noun = typeof CommitmentKinds !== 'undefined' ? CommitmentKinds.label(c).toLowerCase() : 'goal';
            return `\n\nTHIS THREAD (the person is texting you in nenva's thread for ONE ${noun}, the one in CURRENT TASK above, and its steps; their message is about this ${noun} or one of its steps, never ask which ${noun}. To act on a step use its id with your tools. What they report about a step is filed on it by the app before your answer.)\nIts open steps:\n${list.join('\n')}\nWhat they see above their message, oldest first (the chat lines are in the conversation itself):\n${rows.join('\n')}`;
        }
        return `\n\nTHIS THREAD (the person is texting you in nenva's thread for ONE commitment, the one in CURRENT TASK above; their message is about it, never ask which one. What they see above their message, oldest first; the chat lines are in the conversation itself)\n${rows.join('\n')}`;
    },

    // ── Reading the app ─────────────────────────────────────────────────

    _local(key) { try { return JSON.parse(localStorage.getItem(key) || '{}') || {}; } catch { return {}; } },
    _synced() {
        if (typeof Senders === 'undefined') return false;
        if (!this._adopted) { this._adopted = true; try { Senders.adoptLocal(this._local(this.SEEN_KEY), this._local(this.HIDDEN_KEY)); } catch { /* carried next time */ } }
        return true;
    },
    _seen() { return this._synced() ? Senders.seenMap() : this._local(this.SEEN_KEY); },
    _markSeen(id, at) {
        if (this._synced()) { Senders.markSeen(id, at || Date.now()); return; }
        try { const s = this._seen(); s[id] = Math.max(s[id] || 0, at || Date.now()); localStorage.setItem(this.SEEN_KEY, JSON.stringify(s)); } catch { /* a convenience */ }
    },
    /**
     * The thing's one chat (Now's thingKey), or null. A chat that only had
     * the record ATTACHED (`recordKey`, e.g. "Ask about this task" started
     * on Chats) is the thing's chat too when it has no other (2026-10-10,
     * reported: a commitment's thread did not show its existing chat).
     */
    _conv(card) {
        if (typeof SimpleExperience === 'undefined' || typeof AgentService === 'undefined') return null;
        let found = null;
        try { found = SimpleExperience._thingConv(card); } catch { found = null; }
        if (found) return found;
        const id = card.commitment || (/^task:(.+)$/.exec(String(card.key || '')) || [])[1];
        const keys = new Set(id ? [`task:${id}`, `schedule:${id}`, `goal:${id}`, `goals:${id}`] : [String(card.key || '')]);
        return (AgentService.conversations || []).filter(c => c && !c.private && !c.standing && keys.has(String(c.recordKey || '')))
            .sort((a, b) => this._t(b.updatedAt) - this._t(a.updatedAt))[0] || null;
    },
    /** The thing's open Now card (the same list Now draws), or null. */
    _cardFor(key) {
        if (typeof SimpleExperience === 'undefined') return null;
        try {
            if (!this._cards) this._cards = SimpleExperience.cards() || [];
            return this._cards.find(c => SimpleExperience.thingKey(c) === key) || null;
        } catch { return null; }
    },
    _card(m) { return this._cardFor(m.id); },
    /**
     * Cards a package keeps in a thread of its own instead of nenva's
     * (2026-10-12: the money coach's raises about money as a whole live in
     * Your money). `test(card)` claims a card for `key`.
     */
    _cardHomes: [],
    registerCardHome(key, test) { if (key && typeof test === 'function') this._cardHomes.push({ key, test }); },
    _homeOf(card) { const h = this._cardHomes.find(x => { try { return x.test(card); } catch { return false; } }); return h ? h.key : null; },
    _cardsHomedAt(key) {
        if (typeof SimpleExperience === 'undefined' || !this._cardHomes.some(h => h.key === key)) return [];
        try { if (!this._cards) this._cards = SimpleExperience.cards() || []; } catch { return []; }
        return this._cards.filter(c => c && this._homeOf(c) === key);
    },
    _householdCards() {
        if (typeof SimpleExperience === 'undefined') return [];
        try {
            if (!this._cards) this._cards = SimpleExperience.cards() || [];
            const folder = id => typeof Matters !== 'undefined' && Matters.forCalendarEvent ? !!Matters.forCalendarEvent(id) : false;
            const held = id => typeof Senders !== 'undefined' && !!Senders.holderOf('routine', id);
            const jobHeld = id => {
                const j = typeof TeamJobs !== 'undefined' ? TeamJobs.get(id) : null;
                const conv = j && j.conversationId && typeof AgentService !== 'undefined' ? (AgentService.conversations || []).find(c => c.id === j.conversationId) : null;
                return !!(conv && conv.todayKey) || !!(j && j.routineId && held(j.routineId));
            };
            return this.homeless(this._cards, c => SimpleExperience.thingKey(c), folder, held, jobHeld).filter(c => !this._homeOf(c));
        } catch { return []; }
    },
    /** A new general conversation for nenva's thread, made by its first message. */
    _makeGeneral(text) {
        const now = new Date().toISOString();
        const conv = { id: 'conv_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6), title: String(text || 'New chat').replace(/\s+/g, ' ').trim().slice(0, 60) || 'New chat',
            createdAt: now, updatedAt: now, messages: [] };
        AgentService.conversations.unshift(conv);
        AgentService._saveConversations();
        return conv;
    },
    /** Make (or find) the thread's conversation, for a send. */
    _make(key, stub) {
        // A page's box and a record's box keep their host's title, body and
        // record (PageChat PC1); anything else is a thing's chat (Now's).
        if (typeof PageChat !== 'undefined' && (PageChat.isPage(key) || PageChat.hostOf(key))) return PageChat.conv(key, true);
        return SimpleExperience._cardConv(stub || { key, title: 'nenva' }).conv;
    },

    /** One folder's row (a matter's id already reads "matter:…"). */
    _matterRow(m, now, seen) {
        const stub = { key: m.id, matter: m.id, title: Matters.titleOf(m) };
        const conv = this._conv(stub);
        // A folder that IS a calendar event speaks with that meeting's prep card when it has none of its own (M6b).
        const card = this._cardFor(m.id) || (m.calendarEventId && m.state === 'open' ? this._cardFor(`event:${m.calendarEventId}`) : null);
        const items = this.timeline(m, conv, card, now);
        const at = Math.max(this.lastAt(items, m), conv ? this._t(conv.updatedAt) : 0);
        return { key: m.id, type: 'matter', rec: m, stub, title: Matters.titleOf(m), avatar: m.kind || 'other', settled: m.state !== 'open',
            facts: typeof MatterPage !== 'undefined' ? MatterPage.factsLine(m) : '', conv, card, items, at, unread: this._unread(items, at, seen, m.id) };
    },
    _matterRows(now, since, seen) {
        if (typeof Matters === 'undefined') return [];
        return (Matters.forAmbient ? Matters.forAmbient() : Matters.all())
            .filter(m => m.state === 'open' || this._t(m.updatedAt) >= since).map(m => this._matterRow(m, now, seen));
    },
    _commitmentCtx(now) {
        let all = [], ledger = [];
        try { all = Commitments.all(); ledger = Commitments._load().ledger || []; } catch { return null; }
        const byTarget = new Map();
        for (const e of ledger) { if (!e || !e.target || e.by === 'app') continue; if (!byTarget.has(e.target)) byTarget.set(e.target, []); byTarget.get(e.target).push(e); }
        return { all, byTarget, titles: new Map(all.map(c => [c.id, c.title])), today: Commitments.today(now) };
    },
    /** One commitment's row, keyed `task:<id>` like its chat (2026-10-10, by request). */
    _commitmentRow(c, x, now, seen) {
        const key = `task:${c.id}`;
        const stub = { key, commitment: c.id, title: c.title };
        const conv = this._conv(stub);
        const card = this._cardFor(key);
        const items = this.commitmentTimeline(c, conv, card, x.byTarget.get(c.id) || [], now, x.today);
        const ev = this.events(items);
        const at = Math.max(ev.length ? ev[ev.length - 1].at : 0, this._t(c.updatedAt), conv ? this._t(conv.updatedAt) : 0);
        return { key, type: 'commitment', rec: c, stub, title: c.title, avatar: Commitments.kindOf(c, x.all),
            settled: c.state !== 'open', facts: this.commitmentFacts(c, x.today, c.parent ? x.titles.get(c.parent) : '', x.all), conv, card, items, at, unread: this._unread(items, at, seen, key) };
    },

    // ── A goal is one thread (2026-10-11, by request) ───────────────────
    //
    // Ram: the sleep goal and its "Log sleep" step both showed as senders,
    // "kinda confusing". A step is never a thread of its own: it lives in
    // the thread of the goal at the top of its family (Commitments.rootOf),
    // as a member, the way a sender holds its things. The goal's own chat is
    // the thread's; a step's older chat, its card ("how did it go?") and its
    // log show there tagged with the step's name; ThingCapture picks which
    // step a message is about (T6). A step placed in a sender stays the
    // sender's. A family of one is the commitment's own row, as before.

    /** The key of the thread that holds a commitment (`task:<id>`): its goal's, else its own. */
    goalKeyOf(key, all = null) {
        const m = /^task:(.+)$/.exec(String(key || ''));
        if (!m || typeof Commitments === 'undefined') return key;
        try {
            all = all || Commitments.all();
            const c = all.find(x => x.id === m[1]);
            const top = c ? Commitments.rootOf(c, all) : null;
            return top && top.id !== c.id && this._keeps(top) ? `task:${top.id}` : key;
        } catch { return key; }
    },
    /** The key of the thread a thing lives in: the sender holding it, else its goal's, else its own. */
    threadKeyOf(key) {
        try {
            const sid = typeof Senders !== 'undefined' && /^(matter|task):/.test(String(key || '')) ? Senders.senderOf(key) : null;
            const s = sid ? Senders.get(sid) : null;
            if (s && !s.builtIn) return s.id;
        } catch { /* its own */ }
        if (this._isLooseToDo(key)) return Senders.REMINDERS;
        return this.goalKeyOf(key);
    },
    /**
     * Where a link to a commitment goes from here: its thread, or, when its
     * thread is the one already open on this page (a to-do in Reminders'
     * drawer, a step in its goal's), its own page (2026-10-12, Ram: the
     * drawer "already shows the reminders nicely; we can make it a link to
     * the commitment detail page"; before, the row reopened the same thread).
     * Pure over `here`, the thread open on the page (null off the page or in a sheet).
     */
    doorFor(key, here = this._here()) {
        if (!here) return 'thread';
        const thread = this.threadKeyOf(key);
        return thread === here || key === here ? 'page' : 'thread';
    },
    _here() {
        return typeof AppManager !== 'undefined' && AppManager.currentApp === this.APP && !this._sheet ? this._open || null : null;
    },
    /** A `task:<id>` key whose commitment is a loose to-do (Reminders holds it). */
    _isLooseToDo(key) {
        const m = /^task:(.+)$/.exec(String(key || ''));
        if (!m || typeof Senders === 'undefined' || !Senders.isToDo || typeof Commitments === 'undefined') return false;
        try {
            const all = Commitments.all();
            const c = all.find(x => x.id === m[1]);
            return !!c && Senders.isToDo(c, all) && !Senders.senderOf(key);
        } catch { return false; }
    },
    /** One goal's thread from the store; `held` keys (in a sender) stay out. */
    _goalRowFor(top, x, now, seen, since = 0, held = null) {
        const lead = this._commitmentRow(top, x, now, seen);
        const steps = Commitments.family(top, x.all).slice(1)
            .filter(c => this._keeps(c) && !(held && held.has(`task:${c.id}`)) && (c.state === 'open' || this._t(c.updatedAt || c.doneAt) >= since));
        return this.goalRow(lead, steps.map(c => this._commitmentRow(c, x, now, seen)), seen);
    },
    _commitmentRows(now, since, seen, held = null) {
        if (typeof Commitments === 'undefined') return [];
        const x = this._commitmentCtx(now);
        if (!x) return [];
        const recent = c => c.state === 'open' || this._t(c.updatedAt || c.doneAt) >= since;
        // One row per family, at its top: shown while the goal or any step is open or lately active.
        const tops = new Map();
        for (const c of x.all) {
            if (!this._keeps(c) || !recent(c)) continue;
            const top = Commitments.rootOf(c, x.all);
            const lead = top && this._keeps(top) ? top : c;
            if (!tops.has(lead.id)) tops.set(lead.id, lead);
        }
        return [...tops.values()].map(top => this._goalRowFor(top, x, now, seen, since, held));
    },

    /**
     * Every other chat a page holds (2026-10-10, by request: the chats on
     * Commitments and Finance are threads too): a page's box (`page:…`) or a
     * record's (`portfolio:account:…`, a trip, an event). Never a routine's
     * Standing chat, a private chat or one nobody has spoken in.
     */
    _otherKey(c) {
        const k = String((c && (c.pageKey || c.todayKey)) || '');
        if (!k || /^(task|matter|routine|checkin):/.test(k)) return '';
        return k;
    },
    _otherTitle(key, conv, title = '') {
        const host = typeof PageChat !== 'undefined' ? PageChat.hostOf(key) : null;
        return (host && host.title) || title || (conv && (conv.recordLabel || conv.title)) || 'nenva';
    },
    _otherAvatar(key) {
        if (/^(page:portfolio|portfolio:|page:spending|spending:)/.test(key)) return 'money';
        if (/^trip:/.test(key)) return 'reservation';
        if (/^event:/.test(key)) return 'appointment';
        if (key === 'page:commitments') return 'task';
        return 'other';
    },
    _otherRow(key, conv, seen, title = '') {
        const items = [];
        // A conversation's messages keep their order: a reply is never drawn above what it answers.
        let lastMsgAt = 0;
        for (const msg of (conv && conv.messages) || []) {
            if (!msg || !['user', 'assistant'].includes(msg.role) || (msg.metadata && msg.metadata.fromCard)) continue;
            const text = typeof msg.content === 'string' ? msg.content : '';
            if (text.trim()) items.push({ at: (lastMsgAt = Math.max(lastMsgAt, this._t(msg.timestamp) || this._t(conv.updatedAt))), side: msg.role === 'user' ? 'me' : 'them', kind: 'chat', text, md: msg.role === 'assistant', meta: msg.metadata || null });
        }
        // Cards a package keeps in this thread (registerCardHome), newest last, with their buttons.
        for (const card of this._cardsHomedAt(key)) {
            items.push({ at: card.lookAt || lastMsgAt || 0, side: 'them', kind: 'now', text: card.body ? `${this._sentence(card.title)} ${this._sentence(card.body)}` : this._sentence(card.title), card });
        }
        items.sort((a, b) => a.at - b.at);
        const at = Math.max(items.length ? items[items.length - 1].at : 0, conv ? this._t(conv.updatedAt) : 0);
        return { key, type: 'other', rec: null, stub: { key, title: this._otherTitle(key, conv, title) }, title: this._otherTitle(key, conv, title), avatar: this._otherAvatar(key),
            settled: false, facts: '', conv, card: null, items, at, unread: this._unread(items, at, seen, key) };
    },
    /**
     * Threads a package keeps listed even before anyone spoke in them
     * (2026-10-12: Finance's "Your money", while there is money to show).
     * `fn()` returns thread keys; each is an ordinary page chat's row.
     */
    _listed: [],
    registerListed(fn) { if (typeof fn === 'function') this._listed.push(fn); },
    _listedRows(seen, have) {
        const out = [];
        for (const fn of this._listed) {
            let keys = [];
            try { keys = fn() || []; } catch { keys = []; }
            for (const key of keys) {
                if (have.has(key)) continue;
                const conv = typeof PageChat !== 'undefined' ? PageChat.conv(key) : null;
                out.push({ ...this._otherRow(key, conv, seen), pinned: true });
            }
        }
        return out;
    },
    _otherRows(seen) {
        if (typeof AgentService === 'undefined') return [];
        const byKey = new Map();
        for (const c of AgentService.conversations || []) {
            const key = this._otherKey(c);
            if (!key || c.private || c.standing || String(c.id).startsWith('ephemeral_')) continue;
            if (!(c.messages || []).some(m => m.role === 'user')) continue;
            const had = byKey.get(key);
            if (!had || this._t(c.updatedAt) > this._t(had.updatedAt)) byKey.set(key, c);
        }
        return [...byKey].map(([key, c]) => this._otherRow(key, c, seen));
    },
    threads(now = Date.now()) {
        const since = now - this.RECENT_DAYS * 86400000;
        const seen = this._seen();
        const hidden = this._hidden();
        // What a sender holds is in its thread, not beside it (S1).
        const held = new Set();
        const senders = this._senderRows(now, since, seen, held);
        const loose = r => !held.has(r.key);
        // Loose to-dos live in Reminders, pinned under nenva (2026-10-11): never a thread each.
        const commitmentRows = this._commitmentRows(now, since, seen, held).filter(loose);
        const reminders = this._remindersRow(commitmentRows, seen, now);
        const rows = [...senders, ...this._matterRows(now, since, seen).filter(loose), ...commitmentRows.filter(r => !reminders || !reminders.members.includes(r.key)),
            // A sender's own conversation is its thread, never a row beside it (archived ones included).
            ...this._otherRows(seen).filter(r => loose(r) && !/^sender:/.test(r.key))]
            .filter(r => !(hidden[r.key] && this.lastEventAt(r.items) <= hidden[r.key]));
        const nenva = this._nenvaRow(seen);
        // A package's built-in thread (Your money) sits under Reminders, spoken in or not.
        const listedKeys = new Set(this._listed.flatMap(fn => { try { return fn() || []; } catch { return []; } }));
        const listed = [...rows.filter(r => listedKeys.has(r.key)).map(r => ({ ...r, pinned: true })), ...this._listedRows(seen, new Set(rows.map(r => r.key)))];
        const rest = rows.filter(r => !listedKeys.has(r.key));
        // What the person pinned comes next, in pin order (M7: Pinned folded into Threads).
        const pins = this.pinnedFirst(rest, this._pinKeys(), k => this.rowFor(k, now));
        return [...(nenva ? [nenva] : []), ...(reminders ? [reminders] : []), ...listed, ...pins.pinned, ...this.order(pins.rest, this._sticky)];
    },

    // ── Reminders (2026-10-11, by request) ──────────────────────────────
    //
    // Every loose to-do (Senders.isToDo: one time, no goal, no steps, and no
    // sender holds it) lives in ONE built-in thread, pinned under nenva, like
    // a Reminders list: its nudges arrive there, a word there reaches the
    // to-do it is about (ThingCapture T6 over Senders.members), and a to-do
    // that grows steps or finds a sender moves out by itself. Nothing is
    // written to make it: membership is the to-do's shape, read each time.

    /** Is this commitment row a loose to-do's? */
    _isToDoRow(r, all) {
        return !!(r && r.type === 'commitment' && !(r.members || []).length && typeof Senders !== 'undefined' && Senders.isToDo && Senders.isToDo(r.rec, all));
    },
    /** The Reminders row over the loose to-dos' rows, or null when it holds nothing and was never written in. */
    _remindersRow(commitmentRows, seen, now) {
        if (typeof Senders === 'undefined' || !Senders.reminders || typeof Commitments === 'undefined') return null;
        let all = [];
        try { all = Commitments.all(); } catch { return null; }
        const rows = commitmentRows.filter(r => this._isToDoRow(r, all));
        const s = Senders.reminders();
        if (!rows.length && !this._conv({ key: s.id, title: s.name })) return null;
        const row = this._senderRow(s, rows, seen, now);
        return { ...row, avatar: 'task', pinned: true, reminders: true };
    },

    /** The pinned commitments' keys, newest pin first (js/core/pins.js). */
    _pinKeys() {
        try { return typeof Pins !== 'undefined' ? Pins.list().map(p => `task:${p.id}`) : []; } catch { return []; }
    },

    // ── Senders (docs/SENDERS.md M2) ────────────────────────────────────

    _senderRow(s, memberRows, seen, now) {
        const stub = { key: s.id, title: s.name };
        const conv = this._conv(stub);
        const items = this.senderTimeline(s, memberRows, conv, this._cardFor(s.id));
        // A routine about this thing (M8): its news is in the thread, its card too.
        for (const l of (Array.isArray(s.links) ? s.links : []).filter(x => x.kind === 'routine')) {
            for (const r of this._routineNews(l.ref)) items.push(r);
            const rc = this._cardFor(`routine:${l.ref}`);
            if (rc) items.push({ at: Math.max(rc.lookAt || 0, this.lastEventAt(items)), side: 'them', kind: 'now', text: this._sentence(rc.body || rc.title), card: rc, about: l.title || 'Routine' });
        }
        items.sort((a, b) => (a.kind === 'status') - (b.kind === 'status') || (a.at - b.at));
        // Its last real event; making the sender is not one (the first grouping makes them all at once).
        const at = Math.max(this.lastEventAt(items.filter(i => i.kind !== 'intro')), ...memberRows.map(r => r.at), conv ? this._t(conv.updatedAt) : 0) || this._t(s.createdAt);
        // A sender new to this page keeps the read marks its members had.
        const seenAt = seen[s.id] || Math.max(0, ...memberRows.map(r => seen[r.key] || 0));
        const open = memberRows.filter(r => !r.settled);
        const card = (items.filter(x => x.kind === 'now').pop() || {}).card || null;
        const holdsAccounts = (Array.isArray(s.links) ? s.links : []).some(l => l && l.kind === 'account');
        return { key: s.id, type: 'sender', rec: s, stub, title: s.name, avatar: 'letter', letter: this._letter(s.name), settled: !open.length && !holdsAccounts,
            facts: s.allGood || '', conv, card, items, at, members: memberRows.map(r => r.key), memberRows,
            unread: this._unread(items, at, { ...seen, [s.id]: seenAt }, s.id) };
    },
    _senderRows(now, since, seen, held) {
        if (typeof Senders === 'undefined') return [];
        const out = [];
        let x = null;
        for (const s of Senders.all()) {
            const keys = Senders.members(s.id);
            // Money accounts attached to it count as something it holds (its drawer draws them).
            const holdsAccounts = (Array.isArray(s.links) ? s.links : []).some(l => l && l.kind === 'account');
            if (!keys.length && !holdsAccounts && !this._conv({ key: s.id, title: s.name })) continue;
            const memberRows = [];
            for (const k of keys) {
                held.add(k);
                if (/^matter:/.test(k)) { const m = typeof Matters !== 'undefined' ? Matters.get(k) : null; if (m) memberRows.push(this._matterRow(m, now, seen)); continue; }
                const c = typeof Commitments !== 'undefined' ? Commitments.get(k.slice(5)) : null;
                if (!c || !this._keeps(c)) continue;
                x = x || this._commitmentCtx(now);
                if (x) memberRows.push(this._commitmentRow(c, x, now, seen));
            }
            const row = this._senderRow(s, memberRows, seen, now);
            // Shown once something happened on it, and while it is open or lately active.
            if (!row.items.some(i => i.kind !== 'status') && !holdsAccounts) continue;
            if (row.settled && row.at < since && !row.unread) continue;
            out.push(row);
        }
        return out;
    },
    // ── The nenva sender (docs/SENDERS.md M4) ───────────────────────────
    //
    // nenva holds CONVERSATIONS, not things: every general chat (one that
    // no thing, page or routine owns, the ones the Chats page lists). Its
    // thread shows one of them; its info page is the history with New
    // conversation. A new conversation is made by its first message, so an
    // empty one is never kept. Which one is showing is this Mac's choice
    // (`threads-nenva-conv`). Answers here are not held to texting style:
    // a general question may want a full answer.

    NENVA_CONV_KEY: 'threads-nenva-conv',
    NEW_CONV: '__new',
    /** Is this a general conversation (nenva's)? Pure. */
    isGeneral(c) {
        if (!c || !c.id || c.private || c.standing || c.todayKey || c.pageKey || String(c.id).startsWith('ephemeral_')) return false;
        return (c.messages || []).some(m => m && m.role === 'user');
    },
    generalConvs() {
        if (typeof AgentService === 'undefined') return [];
        return (AgentService.conversations || []).filter(c => this.isGeneral(c))
            .sort((a, b) => this._t(b.updatedAt || b.createdAt) - this._t(a.updatedAt || a.createdAt));
    },
    _nenvaPick() { try { return localStorage.getItem(this.NENVA_CONV_KEY) || ''; } catch { return ''; } },
    _setNenvaPick(id) { try { if (id) localStorage.setItem(this.NENVA_CONV_KEY, id); else localStorage.removeItem(this.NENVA_CONV_KEY); } catch { /* a convenience */ } },
    /** The conversation nenva's thread shows: the one picked, else the newest; null for a new one. */
    nenvaConv() {
        const pick = this._nenvaPick();
        if (pick === this.NEW_CONV) return null;
        const all = this.generalConvs();
        const found = pick && typeof AgentService !== 'undefined' ? (AgentService.conversations || []).find(c => c.id === pick && !c.private && !c.standing) : null;
        return found || all[0] || null;
    },
    newNenvaConversation() { this._setNenvaPick(this.NEW_CONV); this._info = null; this._open = 'nenva'; this._repaint(); this._focusComposer(); },
    pickNenvaConversation(id) { this._setNenvaPick(id); this._info = null; this._open = 'nenva'; this._repaint(); this._focusComposer(); },
    _focusComposer() {
        const t = document.querySelector(`#${this.APP}-view .th-compose textarea`);
        if (t) t.focus();
    },
    // ── nenva says what it is reading (2026-10-11, by request) ──────────
    //
    // Ram: "when i connect email, threads page or nenva thread is not showing
    // progress or loading state.. we have this loading state in Now page,
    // threads page is where user is going to do this. so nenva agent need to
    // become the central anchor". So nenva's thread says, as its last bubble,
    // what it is reading right now (the SAME words as Now's lede: EmailHome's
    // statusLine, SimpleExperience._calendarStatus), its row in the list says
    // it too with a spinner, and when the first read after a connect is done
    // nenva says so once, with how many things it is now keeping track of.
    // The live bubble is not an item: it never marks the thread unread.
    READ_DONE_KEY: 'threads-email-read',
    _work() {
        if (typeof SimpleExperience === 'undefined') return null;
        try {
            const email = SimpleExperience.emailHome();
            const line = email && email.reading && !email.blocked && typeof EmailHome !== 'undefined'
                ? ((EmailHome.statusLine({ connected: true, loading: email.loading, queued: email.queued }) || {}).title || '') : '';
            const conns = typeof AccountsManager !== 'undefined' ? AccountsManager.getAll().filter(a => a && a.services && a.services.mail && a.connectedAt).map(a => Date.parse(a.connectedAt) || 0) : [];
            const lastSync = typeof EmailApp !== 'undefined' && EmailApp.lastSyncTime ? Date.parse(EmailApp.lastSyncTime) || 0 : 0;
            return this.workState({ email: email ? { ...email, line } : null, connectedAt: conns.length ? Math.max(...conns) : 0, lastSync, calendar: SimpleExperience._calendarStatus() });
        } catch { return null; }
    },
    /** The "I've read your email" item, stamped the first time this Mac saw that read finished. */
    _readDoneItem(work, now = Date.now()) {
        if (!work || !work.done) return null;
        let st = null;
        try { st = JSON.parse(localStorage.getItem(this.READ_DONE_KEY) || 'null'); } catch { st = null; }
        if (!st || st.conn !== work.done) {
            st = { conn: work.done, at: now };
            try { localStorage.setItem(this.READ_DONE_KEY, JSON.stringify(st)); } catch { /* per-Mac */ }
        }
        let n = 0;
        try { if (typeof Matters !== 'undefined') n = Matters.all().filter(m => m && m.state === 'open' && Matters.messagesOf(m).length).length; } catch { n = 0; }
        return { at: st.at, side: 'them', kind: 'read-done', text: this.readDoneText(n) };
    },

    /**
     * The morning line (docs/THREADS_DEMO.md G7, 2026-10-12): one bubble in
     * nenva's thread, from 07:30, naming each sender whose look has a card
     * open, in the card's own words, as a door to its thread; "Everything
     * else is on track." only when nothing else is overdue. Joined by code
     * from what the looks raised; nothing here is model-written. Pure:
     * `cards` are { sender, name, title }, `overdue` the count of open
     * commitments past their day.
     */
    MORNING_HOUR: 7, MORNING_MINUTE: 30,
    morningLine(cards, { name = '', overdue = 0 } = {}) {
        const list = (cards || []).filter(c => c && c.sender && c.name && c.title);
        if (!list.length) return '';
        const hello = name ? `Good morning, ${name}.` : 'Good morning.';
        const n = list.length;
        // The card's title as the look wrote it (never re-cased by a rule: "Mr." is not a sentence start).
        const lines = list.map(c => `- [${c.name}](anjadhe://sender/${c.sender}): ${String(c.title).replace(/[.!?]+$/, '')}`);
        const tail = overdue > 0 ? `\n\n${overdue === 1 ? 'One thing is' : `${overdue} things are`} overdue; the rest is on track.` : '\n\nEverything else is on track.';
        return `${hello} ${n === 1 ? 'One thing wants' : `${n} things want`} a look:\n\n${lines.join('\n')}${tail}`;
    },
    _morningItem() {
        try {
            if (typeof SenderLook === 'undefined' || typeof Senders === 'undefined') return null;
            const now = new Date();
            const cards = SenderLook.cards(now).map(c => { const s = Senders.get(c.sender); return s ? { sender: c.sender, name: s.name, title: c.title, at: c.at || 0 } : null; }).filter(Boolean);
            if (!cards.length) return null;
            const today = typeof Commitments !== 'undefined' && Commitments.today ? Commitments.today() : '';
            const overdue = today && typeof Commitments !== 'undefined' && Commitments.all ? Commitments.all().filter(c => c && c.state === 'open' && c.when && c.when.date && c.when.date < today && !(c.repeat && c.repeat.rule && c.repeat.rule !== 'none')).length : 0;
            const name = typeof Proactive !== 'undefined' && Proactive.firstName ? Proactive.firstName() : '';
            const text = this.morningLine(cards, { name, overdue });
            if (!text) return null;
            const at = new Date(now); at.setHours(this.MORNING_HOUR, this.MORNING_MINUTE, 0, 0);
            // From 07:30 today, or when the newest card came if that was later.
            const when = Math.max(at.getTime() > now.getTime() ? at.getTime() - 86400000 : at.getTime(), ...cards.map(c => c.at || 0));
            return { at: when, side: 'them', kind: 'morning', text, md: true };
        } catch (e) { console.warn('[threads] morning line failed:', e && e.message); return null; }
    },

    _nenvaRow(seen) {
        if (typeof Senders === 'undefined') return null;
        const s = Senders.nenva();
        const stub = { key: s.id, title: 'nenva' };
        const conv = this.nenvaConv();
        // The money coach's cards about their money as a whole live here (docs/SENDERS.md M6b).
        const items = this.senderTimeline(s, [], conv);
        // A card's time: its look's, else when its raise opened (Raises), so a thread of them reads in order.
        const raisedAt = c => { try { const r = typeof Raises !== 'undefined' ? Raises.get(SimpleExperience.thingKey(c)) : null; return r ? this._t(r.raisedAt) : 0; } catch { return 0; } };
        for (const card of this._householdCards()) items.push({ at: card.lookAt || raisedAt(card) || this.lastEventAt(items), side: 'them', kind: 'now', text: card.body ? `${this._sentence(card.title)} ${this._sentence(card.body)}` : this._sentence(card.title), card });
        const work = this._work();
        const done = this._readDoneItem(work);
        if (done) items.push(done);
        // The morning line (docs/THREADS_DEMO.md G7): code's join of the senders
        // with an open card, each a door to its thread; never model-written.
        const morning = this._morningItem();
        if (morning) items.push(morning);
        // The cards sit among the conversation by time, not after it.
        items.sort((a, b) => (a.kind === 'status') - (b.kind === 'status') || (a.at - b.at));
        const at = Math.max(this.lastEventAt(items), conv ? this._t(conv.updatedAt) : 0);
        // Before the person has ever talked to nenva, it says hello first and
        // promises to show the rest gradually (2026-10-11, by request: a new
        // install showed everything at once; SimpleExperience.gentle paces it).
        if (!conv && !this.generalConvs().length) {
            const first = (items[0] && items[0].at) || at || Date.now();
            items.unshift({ at: first, side: 'them', kind: 'welcome', text: this.WELCOME }, { at: first, side: 'them', kind: 'welcome', text: this.WELCOME_GOALS });
        }
        if (!items.length) items.push({ at: 0, side: 'them', kind: 'status', text: conv ? 'Nothing here yet.' : 'Ask me anything. Each thing I look after for you has its own thread below.' });
        const title = conv && conv.title && conv.title !== 'New chat' ? conv.title : '';
        return { key: s.id, type: 'nenva', rec: s, stub, title: 'nenva', avatar: 'nenva', settled: false, facts: title, conv, card: null, items, at, pinned: true,
            working: work && work.busy ? work : null, unread: this._unread(items, at, seen, s.id) };
    },

    // ── Deleting a thread (2026-10-10, by request) ──────────────────────
    //
    // A thread is a view of a thing; deleting it deletes its CHAT (every
    // conversation tied to it, as delete_chat does one) and hides the
    // thread on this Mac until something new happens on it, as Messages
    // does. The commitment or folder itself is never touched: it stays in
    // Memory. The chat is deleted only when the Undo toast has passed.

    _hidden() { return this._synced() ? Senders.hiddenMap() : this._local(this.HIDDEN_KEY); },
    _setHidden(key, at) {
        if (this._synced()) { Senders.setHidden(key, at); return; }
        try { const h = this._hidden(); if (at) h[key] = at; else delete h[key]; localStorage.setItem(this.HIDDEN_KEY, JSON.stringify(h)); } catch { /* a convenience */ }
    },
    /** Every conversation that is this thread's chat. */
    convsOf(key, row = null) {
        if (typeof AgentService === 'undefined') return [];
        const keys = new Set([key, ...((row && row.members) || [])]);
        const list = (AgentService.conversations || []).filter(c => c && !c.private && !c.standing && keys.has(c.pageKey || c.todayKey));
        for (const r of (row && row.memberRows) || []) if (r.conv && !list.includes(r.conv)) list.push(r.conv);
        if (row && row.conv && !list.includes(row.conv)) list.push(row.conv);
        return list;
    },
    remove(key) {
        if (!key) return;
        const row = (this._rows || []).find(r => r.key === key) || this.rowFor(key);
        const convs = this.convsOf(key, row);
        if (convs.some(c => AgentService.isConversationStreaming && AgentService.isConversationStreaming(c.id)) || this._sending.has(key)) {
            if (typeof UIUtils !== 'undefined') UIUtils.showToast('nenva is still answering in this thread; try again when it finishes.', 'error');
            return;
        }
        const title = row ? row.title : 'thread';
        const hiddenAt = Date.now();
        this._setHidden(key, hiddenAt);
        if (this._sheet && this._sheet.key === key) this.closeSheet();
        if (this._open === key) this._open = null;
        this._sticky = null;
        this._repaint();
        const ids = convs.map(c => c.id);
        const timer = setTimeout(() => {
            for (const id of ids) { try { AgentService.deleteConversation(id); } catch (e) { console.warn('[threads] delete failed:', e); } }
            this._repaint();
        }, this.UNDO_MS);
        const what = ids.length ? 'its chat deleted' : 'hidden';
        if (typeof UIUtils !== 'undefined') UIUtils.showToast(`“${title}”: ${what}. It comes back when something new happens.`, 'success', this.UNDO_MS, {
            actionLabel: 'Undo', onAction: () => { clearTimeout(timer); if (this._hidden()[key] === hiddenAt) this._setHidden(key, null); this._open = key; this._repaint(); }
        });
    },
    /** One thread's row by its key, built alone (the sheet), or null. */
    rowFor(key, now = Date.now(), title = '') {
        if (!key) return null;
        const seen = this._seen();
        if (typeof Senders !== 'undefined') {
            if (key === Senders.NENVA) return this._nenvaRow(seen);
            if (key === Senders.REMINDERS || (/^task:/.test(key) && this._isLooseToDo(key))) {
                const since = now - this.RECENT_DAYS * 86400000;
                const r = this._remindersRow(this._commitmentRows(now, since, seen, null), seen, now);
                if (r) return r;
            }
            // A folder or commitment a sender holds opens the sender's thread (S1).
            const owner = /^sender:/.test(key) ? key : /^(matter|task):/.test(key) ? Senders.senderOf(key) : null;
            const s = owner && Senders.get(owner);
            if (s && !s.builtIn) {
                const since = now - this.RECENT_DAYS * 86400000;
                const row = this._senderRows(now, since - 3650 * 86400000, seen, new Set()).find(r => r.key === s.id);
                if (row) return row;
            }
        }
        if (/^matter:/.test(key) && typeof Matters !== 'undefined') { const m = Matters.get(key); return m ? this._matterRow(m, now, seen) : null; }
        const t = /^task:(.+)$/.exec(key);
        if (t && typeof Commitments !== 'undefined') {
            // A step opens its goal's thread.
            const c = Commitments.get(t[1]); const x = c && this._commitmentCtx(now);
            if (!c || !x) return null;
            const top = Commitments.rootOf(c, x.all);
            return this._goalRowFor(top && this._keeps(top) ? top : c, x, now, seen, now - this.RECENT_DAYS * 86400000);
        }
        let conv = null;
        if (typeof PageChat !== 'undefined') conv = PageChat.conv(key);
        if (!conv && typeof AgentService !== 'undefined') conv = (AgentService.conversations || []).filter(c => (c.pageKey || c.todayKey) === key)
            .sort((a, b) => this._t(b.updatedAt) - this._t(a.updatedAt))[0] || null;
        return this._otherRow(key, conv, seen, title);
    },

    // ── The page ────────────────────────────────────────────────────────

    _wireHost(el) {
        el.addEventListener('click', e => this.onClick(e));
        el.addEventListener('submit', e => {
            if (!e.target.matches('.th-compose')) return;
            e.preventDefault();
            const input = e.target.querySelector('textarea');
            const text = input.value.trim();
            const key = e.target.closest('.th-thread')?.dataset.id;
            if (text && key) { input.value = ''; this.send(key, text); }
        });
        el.addEventListener('keydown', e => {
            if (e.target.matches('.th-compose textarea') && e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
                e.preventDefault();
                e.target.form.requestSubmit();
            }
        });
    },
    mount() {
        if (this._mounted || typeof document === 'undefined') return;
        this._mounted = true;
        const page = document.createElement('main');
        page.id = `${this.APP}-view`;
        // app-view-full: a two-pane page takes the whole window (core.css caps
        // every other page's sections at --app-content-max and centres them,
        // which left the ground showing beside both panes on a wide window).
        page.className = 'view app-view app-view-full th-page';
        page.setAttribute('aria-label', 'Threads');
        page.innerHTML = `<section class="th-list" aria-label="Conversations">
                <header class="th-list-head"><h1>Threads</h1>
                    <input type="search" class="th-search" placeholder="Search" aria-label="Search threads"></header>
                <div class="th-rows" role="list"></div>
                <div class="th-resize" role="separator" aria-orientation="vertical" aria-label="Resize the list" tabindex="0" title="Drag to resize · double-click to reset"></div></section>
            <section class="th-thread" aria-live="polite"></section>`;
        (document.getElementById('app-views') || document.body).append(page);
        this._wireHost(page);
        this._wireResize(page);
        page.addEventListener('input', e => {
            if (e.target.matches('.th-nenva-search')) { this._nenvaQuery = e.target.value; this.renderThread(); return; }
            if (e.target.matches('.th-search')) { this._query = e.target.value; this.renderList(); }
        });
        // init runs on every arrival through AppManager (a nav tap, home, a
        // door from another page), never on a repaint: the day's folds reset
        // there (a look, never a state), as they did on every visit to Now.
        if (typeof AppManager !== 'undefined') AppManager.register(this.APP, { init: () => { this._dayOpen = false; this._dayMore = false; this._comingOpen = false; this._comingDay = null; }, render: () => this.render() });
        const refresh = () => {
            if (document.hidden) return;
            if (typeof AppManager !== 'undefined' && AppManager.currentApp === this.APP) this.render();
            if (this._sheet) this.paintSheet();
        };
        document.addEventListener('anjadhe:data-changed', refresh);
        // Reading mail moves without a store write the page hears (EmailApp's
        // progress event), and a sync starts on its own: listen, and look again
        // every few seconds while nenva says it is reading.
        document.addEventListener('anjadhe:attention-changed', () => { clearTimeout(this._refreshTimer); this._refreshTimer = setTimeout(refresh, 150); });
        window.addEventListener('focus', refresh);
        // Some news arrives on the CLOCK with no write anyone hears: a repeat's
        // "how did it go?" two hours after it ends, a to-do turning overdue, a
        // raise whose time came (Raises.refresh runs only when something
        // draws). Without a look of its own the list showed it, and its unread
        // dot, only on the next thread switch (2026-10-12, reported). So: look
        // again every minute while Threads is on screen, and when the window
        // comes back into view.
        let lastLook = Date.now();
        setInterval(() => {
            const due = Date.now() - lastLook >= this.CLOCK_LOOK_MS;
            if (due || (this._rows || []).some(r => r.working) || this._readingSoon()) { lastLook = Date.now(); refresh(); }
        }, 5000);
        document.addEventListener('visibilitychange', () => { if (!document.hidden) { lastLook = Date.now(); refresh(); } });
        window.electronStore?.onKeyChanged?.(() => { clearTimeout(this._refreshTimer); this._refreshTimer = setTimeout(refresh, 150); });
        document.addEventListener('keydown', e => {
            if (e.key === 'Escape' && this._sheet && !document.querySelector('dialog[open]')) { e.stopPropagation(); this.closeSheet(); }
        }, true);
    },
    // ── The list's width (2026-10-10, by request: "make the threads left nav resizable") ──
    LIST_W: { key: 'threads-list-width', min: 220, max: 560, def: 320, step: 16 },
    /** A stored or dragged width, held inside the bounds. Pure. */
    clampWidth(w) {
        const n = Math.round(Number(w));
        return Number.isFinite(n) ? Math.min(this.LIST_W.max, Math.max(this.LIST_W.min, n)) : this.LIST_W.def;
    },
    _setListWidth(page, w, { save = false } = {}) {
        const px = this.clampWidth(w);
        page.style.setProperty('--th-list-w', `${px}px`);
        const h = page.querySelector('.th-resize');
        if (h) { h.setAttribute('aria-valuenow', String(px)); h.setAttribute('aria-valuemin', String(this.LIST_W.min)); h.setAttribute('aria-valuemax', String(this.LIST_W.max)); }
        // Per Mac, like the nav's collapse: a convenience, never synced.
        if (save) { try { localStorage.setItem(this.LIST_W.key, String(px)); } catch { /* the width still applies */ } }
        return px;
    },
    _wireResize(page) {
        let stored = null;
        try { stored = localStorage.getItem(this.LIST_W.key); } catch { stored = null; }
        this._setListWidth(page, stored == null ? this.LIST_W.def : stored);
        const handle = page.querySelector('.th-resize');
        const list = page.querySelector('.th-list');
        if (!handle || !list) return;
        handle.addEventListener('pointerdown', e => {
            if (e.button !== 0) return;
            e.preventDefault();
            const left = list.getBoundingClientRect().left;
            page.classList.add('is-resizing');
            try { handle.setPointerCapture(e.pointerId); } catch { /* a synthetic pointer */ }
            const move = ev => this._setListWidth(page, ev.clientX - left);
            const up = ev => {
                handle.removeEventListener('pointermove', move);
                handle.removeEventListener('pointerup', up);
                handle.removeEventListener('pointercancel', up);
                page.classList.remove('is-resizing');
                this._setListWidth(page, ev.clientX - left, { save: true });
            };
            handle.addEventListener('pointermove', move);
            handle.addEventListener('pointerup', up);
            handle.addEventListener('pointercancel', up);
        });
        handle.addEventListener('dblclick', () => this._setListWidth(page, this.LIST_W.def, { save: true }));
        handle.addEventListener('keydown', e => {
            const now = list.getBoundingClientRect().width;
            if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
                e.preventDefault();
                this._setListWidth(page, now + (e.key === 'ArrowRight' ? 1 : -1) * this.LIST_W.step, { save: true });
            }
        });
    },
    open(id = null) {
        this.mount();
        if (id) this._open = id;
        if (this._sheet) this.closeSheet();
        if (typeof AppManager === 'undefined') return;
        if (AppManager.currentApp !== this.APP) AppManager.openAppFromLauncher(this.APP);
        else this.render();
    },
    render() {
        this._cards = null;
        // First visit: everything already there counts as read.
        const seen = this._seen();
        if (!seen.__init) {
            const rows = this.threads();
            if (this._synced()) Senders.initSeen(rows.map(r => [r.key, r.at]));
            else try { const s = { __init: 1 }; rows.forEach(r => { s[r.key] = r.at; }); localStorage.setItem(this.SEEN_KEY, JSON.stringify(s)); } catch { /* a convenience */ }
        }
        this._rows = this.threads();
        // A folder joined into another: follow its alias.
        if (this._open && /^matter:/.test(this._open) && typeof Matters !== 'undefined') { const m = Matters.get(this._open); if (m) this._open = m.id; }
        // A thing a sender holds opens the sender's thread.
        if (this._open && !this._rows.some(r => r.key === this._open)) { const own = this._rows.find(r => (r.members || []).includes(this._open)); if (own) this._open = own.key; }
        // A thread opened by a door (an account's link, Your money's drawer) that the list does not
        // hold yet, because nobody has spoken in it: shown at the top of the list while it is open.
        if (this._open && !this._rows.some(r => r.key === this._open)) {
            const extra = this.rowFor(this._open);
            if (extra && extra.type !== 'nenva') { const at = this._rows.findIndex(r => !r.pinned && r.type !== 'nenva'); this._rows.splice(at < 0 ? this._rows.length : at, 0, extra); }
        }
        if (!this._rows.some(r => r.key === this._open)) this._open = this._rows.length ? this._rows[0].key : null;
        const row = this._rows.find(r => r.key === this._open);
        if (row) { this._markSeen(row.key, row.at); row.unread = false; }
        this.renderList();
        this.renderThread();
    },

    avatar(kind) {
        const paths = {
            appointment: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 11h18"/>',
            bill: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/>',
            order: '<path d="M3 7l9-4 9 4v10l-9 4-9-4z"/><path d="m3 7 9 4 9-4M12 11v10"/>',
            reservation: '<path d="M2 12h20M12 2c3 3 4 6 4 10s-1 7-4 10c-3-3-4-6-4-10s1-7 4-10z"/><circle cx="12" cy="12" r="10"/>',
            subscription: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
            other: '<path d="M4 4h16v12H8l-4 4z"/>',
            task: '<rect x="4" y="4" width="16" height="16" rx="4"/><path d="m8 12 3 3 5-6"/>',
            repeat: '<path d="M17 2l3 3-3 3"/><path d="M4 11V9a4 4 0 0 1 4-4h12"/><path d="M7 22l-3-3 3-3"/><path d="M20 13v2a4 4 0 0 1-4 4H4"/>',
            goal: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
            money: '<path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/>'
        };
        // A commitment's kind draws its own icon (CommitmentKinds).
        const kindIcon = typeof CommitmentKinds !== 'undefined' && CommitmentKinds._kinds.has(kind) ? CommitmentKinds.get(kind).icon : null;
        return `<span class="th-avatar th-kind-${this.esc(kind || 'other')}" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${kindIcon || paths[kind] || paths.other}</svg></span>`;
    },

    /** A row's picture: a sender is its first letter (a contact), nenva its own mark, anything else its kind. */
    avatarOf(r) {
        if (r && r.avatar === 'letter') return `<span class="th-avatar th-avatar-letter" aria-hidden="true">${this.esc(r.letter || '·')}</span>`;
        if (r && r.avatar === 'nenva') return '<span class="th-avatar th-avatar-nenva" aria-hidden="true">n</span>';
        return this.avatar(r && r.avatar);
    },
    renderList() {
        const host = document.querySelector(`#${this.APP}-view .th-rows`);
        if (!host) return;
        const q = this._query.trim().toLowerCase();
        const rows = (this._rows || []).filter(r => !q || (r.title + ' ' + this.preview(r.items) + ' ' + ((r.memberRows || []).map(m => m.title).join(' '))).toLowerCase().includes(q));
        if (!rows.length) { host.innerHTML = `<p class="th-empty">${q ? 'Nothing matches.' : 'Nothing nenva is keeping track of yet. Your commitments, the bills, orders and appointments from your mail, and your chats on each page each get a thread here.'}</p>`; return; }
        // Rows are PATCHED in place, never rebuilt (2026-10-11): while mail is
        // read every analysed message repaints the page, and rebuilding the
        // list replaced the row under the pointer many times a second: a
        // click's mousedown and mouseup landed on two different nodes (no
        // click fired) and the hover state reset each time (the delete button
        // faded in and out). A thread keeps its element; only what changed is
        // rewritten, and nodes move only when the order did.
        const have = new Map();
        host.querySelectorAll(':scope > .th-row').forEach(el => have.set(el.dataset.id, el));
        const next = rows.map(r => {
            const cls = `th-row${r.key === this._open ? ' is-on' : ''}${r.unread ? ' is-unread' : ''}${r.settled ? ' is-settled' : ''}${r.pinned ? ' is-pinned' : ''}`;
            const inner = this.rowHtml(r);
            let el = have.get(r.key);
            if (!el) { el = document.createElement('button'); el.type = 'button'; el.setAttribute('role', 'listitem'); el.dataset.th = 'open'; el.dataset.id = r.key; }
            if (el.className !== cls) el.className = cls;
            if (el._th !== inner) { el.innerHTML = inner; el._th = inner; }
            return el;
        });
        const kids = Array.from(host.children);
        if (kids.length !== next.length || kids.some((k, i) => k !== next[i])) {
            next.forEach((el, i) => { if (host.children[i] !== el) host.insertBefore(el, host.children[i] || null); });
            Array.from(host.children).slice(next.length).forEach(el => el.remove());
        }
    },
    /** The inside of one row (the button is the element renderList keeps). Pure. */
    rowHtml(r) {
        return `<span class="th-dot" aria-hidden="true"></span>${this.avatarOf(r)}
                <span class="th-row-main"><span class="th-row-top"><span class="th-row-name">${r.pin ? '<svg class="th-row-pin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-label="Pinned"><path d="M12 17v5M9 3h6l-1 6 3 3v2H7v-2l3-3z"/></svg>' : ''}${this.esc(r.title)}</span><span class="th-row-time">${this.esc(this.timeLabel(r.at))}</span></span>
                <span class="th-row-preview">${r.working ? `<span class="th-busy" aria-hidden="true"></span>${this.esc(r.working.text)}` : this.esc(this.preview(r.items))}</span></span>
                ${r.pinned ? '' : `<span class="th-row-del" role="button" tabindex="-1" data-th="delete" data-id="${this.esc(r.key)}" title="Delete thread" aria-label="Delete thread"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg></span>`}`;
    },

    renderThread() {
        const host = document.querySelector(`#${this.APP}-view .th-thread`);
        if (!host) return;
        const row = (this._rows || []).find(r => r.key === this._open);
        this.paintThread(host, row);
    },

    _hash(v) { const t = JSON.stringify(v || null); let h = 5381; for (let i = 0; i < t.length; i++) h = ((h * 33) ^ t.charCodeAt(i)) >>> 0; return h.toString(36); },
    /** Does this row have a page of its own to open? */
    _detailsFor(key) {
        if (/^sender:/.test(key)) return true;   // its info page (M3)
        if (key === 'nenva') return true;        // its conversations (M4)
        if (/^task:|^matter:/.test(key)) return true;
        return key === 'page:commitments';
    },
    /**
     * Draw one thread into a host (the page's right column, or the sheet).
     * The composer is built once per thread and never repainted, so a
     * background save mid-typing cannot move the caret or drop words; the
     * header and bubbles repaint only when what they show changed.
     */
    paintThread(host, row, { sheet = false } = {}) {
        if (!row) { host.innerHTML = '<p class="th-empty th-empty-thread">Pick a thread.</p>'; host.dataset.id = ''; return; }
        if (row.type === 'sender' && this._info === row.key) { this.paintInfo(host, row, { sheet }); return; }
        if (row.type === 'nenva' && this._info === row.key) { this.paintNenvaInfo(host, row, { sheet }); return; }
        if (host.dataset.info) { delete host.dataset.info; host.dataset.id = ''; host._infoHtml = null; }
        const { conv, items, facts } = row;
        const ui = typeof AgentUI !== 'undefined' ? AgentUI : null;
        // An approval this thread's turn is waiting on: nenva is not typing, the person is.
        const asking = !!(conv && ui && ui.pendingAttention && ui.pendingAttention().some(a => a.kind === 'permission' && a.conversationId === conv.id));
        const typing = !asking && (this._sending.has(row.key) || !!(conv && typeof AgentService !== 'undefined' && AgentService._streamingState && AgentService._streamingState.has(conv.id)));
        let prev = 0, html = '', lastAbout = '';
        const metas = [];
        // nenva's welcome is what an empty thread says, not a status.
        const status = row.type === 'nenva' ? '' : this.statusOf(items);
        this.events(items).forEach((x, i, list) => {
            if (!prev || x.at - prev > 3600000) html += `<div class="th-stamp">${this.esc(this.stampLabel(x.at || Date.now()))}</div>`;
            const tail = (list[i + 1] && list[i + 1].side) !== x.side ? ' has-tail' : '';
            const body = x.md && ui && ui.formatContent ? ui.formatContent(x.text, { views: x.meta && x.meta.views }) : this.esc(x.text);
            const via = x.kind === 'message' ? this.linkCard(x) : '';
            // What rides under an answer (receipts with Undo, records, a job's
            // line, sources): AgentUI's own builder, filled in after paint.
            const extras = x.side === 'them' && x.kind === 'chat' && x.meta ? `<div class="th-extras" data-meta="${metas.push(x.meta) - 1}" data-h="${this._hash(x.meta)}"></div>` : '';
            // In a sender's thread, which thing a bubble is about, when it changes.
            const about = this.captionHtml(x, lastAbout);
            if (x.about) lastAbout = x.about;
            html += `${about}<div class="th-b th-${x.side} th-k-${x.kind}${tail}"><div class="th-bubble">${body}</div>${extras}${via}</div>`;
            if (x.kind === 'intro') {
                html += `<div class="th-chips">${[['keep', 'Keep'], ['rename', 'Rename'], ['fold', 'Fold into…']].map(([a, l]) => `<button type="button" class="th-chip${a === 'keep' ? ' is-primary' : ''}" data-th="sender" data-act="${a}" data-id="${this.esc(x.sender)}">${l}</button>`).join('')}</div>`;
            }
            if (x.card && typeof SimpleExperience !== 'undefined') {
                const acts = SimpleExperience.cardActs(x.card).filter(a => !a.feedback);
                if (acts.length) html += `<div class="th-chips">${acts.map(a => `<button type="button" class="th-chip${a.act === 'primary' ? ' is-primary' : ''}" data-th="act" data-key="${this.esc(x.card.key)}" data-act="${this.esc(a.act)}">${this.esc(a.label)}</button>`).join('')}</div>`;
            }
            prev = x.at || prev;
        });
        // What nenva is reading right now, as its last word (never an item: it
        // marks nothing unread). On the page, nenva's thread says it on the
        // Today heading instead (dayHtml); the bubble stays for the sheet.
        if (row.working && !typing && !(row.type === 'nenva' && !sheet)) html += `<div class="th-b th-them has-tail th-k-working"><div class="th-bubble"><span class="th-busy" aria-hidden="true"></span>${this.esc(row.working.text)}<span class="th-work-meta">${this.esc(this.WORK_META)}</span></div></div>`;
        if (!html && !typing) html = `<p class="th-empty th-empty-thread">${row.type === 'nenva' ? this.esc(this.statusOf(items)) : sheet ? 'Ask nenva anything about this.' : 'Nothing here yet.'}</p>`;
        if (typing) html += '<div class="th-b th-them has-tail"><div class="th-bubble th-typing" aria-label="nenva is typing"><i></i><i></i><i></i></div></div>';
        if (host.dataset.id !== row.key || !host.querySelector('.th-compose')) {
            host.dataset.id = row.key;
            host.innerHTML = `<aside class="th-panel" aria-label="What this thread is tracking" hidden></aside><header class="th-head"></header><div class="th-ask agent-inline-ask" hidden></div><section class="th-day" aria-label="Today" hidden></section><div class="th-bubbles"></div>
                <form class="th-compose"><textarea rows="1" placeholder="Message"></textarea>
                <button type="submit" class="th-send" aria-label="Send"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6"/></svg></button></form>`;
            host.querySelector('.th-compose textarea').setAttribute('aria-label', row.type === 'nenva' ? 'Message nenva' : `Message about ${row.title}`);
            host._paint = {};
        }
        const icon = d => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
        // What it is tracking, drawn (docs/THREAD_PANELS.md): the button only when there is a block (V2).
        const panel = this.panelFor(row);
        const panelOpen = !!panel.length && this._panel === row.key;
        const head = `${this.avatarOf(row)}<span class="th-head-main"><span class="th-head-name">${this.esc(row.title)}</span>${facts ? `<span class="th-head-facts">${this.esc(facts)}</span>` : ''}${status ? `<span class="th-head-status">${this.esc(status)}</span>` : ''}</span>
                ${sheet ? '<button type="button" class="th-head-link" data-th="all">All threads</button>' : ''}
                ${row.type === 'nenva' ? `<button type="button" class="th-info" data-th="nenva-new" title="New conversation" aria-label="New conversation">${icon('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>')}</button>` : ''}
                ${panel.length ? `<button type="button" class="th-info${panelOpen ? ' is-on' : ''}" data-th="panel" title="What it is tracking" aria-label="What it is tracking" aria-pressed="${panelOpen}">${icon('<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>')}</button>` : ''}
                ${this._detailsFor(row.key) ? `<button type="button" class="th-info" data-th="details" title="${row.type === 'nenva' ? 'Conversations' : 'Details'}" aria-label="${row.type === 'nenva' ? 'Conversations' : 'Details'}">${icon('<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5h.01"/>')}</button>` : ''}
                ${sheet || row.pinned ? '' : `<button type="button" class="th-info" data-th="delete" title="Delete thread" aria-label="Delete thread">${icon('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>')}</button>`}
                ${sheet ? `<button type="button" class="th-info" data-th="close" title="Close" aria-label="Close">${icon('<path d="M6 6l12 12M18 6 6 18"/>')}</button>` : ''}`;
        if (host._paint.head !== head) { host.querySelector('.th-head').innerHTML = head; host._paint.head = head; }
        this.paintPanel(host, row, panelOpen ? panel : null);
        // The day, at the top of nenva's thread on the page (not in a sheet).
        const dayEl = host.querySelector('.th-day');
        const day = row.type === 'nenva' && !sheet ? this.dayHtml(this._schedule(), this, row.working) : '';
        if (dayEl && host._paint.day !== day) { dayEl.innerHTML = day; dayEl.hidden = !day; host._paint.day = day; }
        const box = host.querySelector('.th-bubbles');
        if (host._paint.bubbles !== html) {
            const atBottom = host._paint.bubbles == null || box.scrollHeight - box.scrollTop - box.clientHeight < 40;
            box.innerHTML = html;
            host._paint.bubbles = html;
            if (ui && ui.appendAnswerExtras) {
                for (const el of box.querySelectorAll('.th-extras')) {
                    try { ui.appendAnswerExtras(el, metas[Number(el.dataset.meta)]); } catch (e) { console.warn('[threads] extras failed:', e); }
                    if (!el.childNodes.length) el.remove();
                }
            }
            if (atBottom) box.scrollTop = box.scrollHeight;
        }
        // The approval ribbon under the header (AgentUI builds the card).
        const slot = host.querySelector('.th-ask');
        if (ui && ui.paintAskInto) ui.paintAskInto(slot, [conv && conv.id]);
        else if (slot) slot.hidden = true;
        host.querySelector('.th-send').disabled = typing || asking;
    },

    /**
     * The caption over a run of bubbles in a sender's thread: what they are
     * about, when it changes. A hand-off names the chat it came from; a
     * member's caption is the door to its own page (2026-10-12, Ram: make
     * the reminder's text "clickable to launch the commitment detail page"),
     * through the same `item` door as the info page's rows. Pure.
     */
    captionHtml(x, lastAbout = '') {
        if (x.handoff) return `<button type="button" class="th-about th-about-link" data-th="nenva-pick" data-id="${this.esc(x.handoff)}">${this.esc(x.about)}</button>`;
        if (!x.about || x.about === lastAbout) return '';
        if (x.member && /^(task|matter):/.test(x.member)) return `<button type="button" class="th-about th-about-item" data-th="item" data-key="${this.esc(x.member)}" title="Open">${this.esc(x.about)}</button>`;
        return `<div class="th-about">${this.esc(x.about)}</div>`;
    },

    // ── The day at the top of nenva's thread (2026-10-11) ───────────────
    //
    // What Now showed of the day, now the head of nenva's thread, FOLDED to
    // one heading by default (Ram, later the same day: "today and coming up
    // could be part of expandable section instead of always be there"): the
    // heading says Today, how many things, and the day line. Open, it is
    // TODAY as a short list (the time in a left column, the title opening
    // where the thing lives, nenva's one line of help under it), DAY_SHOW
    // rows then "N more today", and COMING UP folded to its own heading
    // inside it, opening to the one next thing, the week as a strip with a
    // dot per thing, and a tapped day's rows. State (`_dayOpen`,
    // `_dayMore`, `_comingOpen`, `_comingDay`) resets on every visit to the
    // page: a look, never a state. What nenva is reading right now (the
    // mailbox, the calendar) is on this heading too, at its right edge with
    // its turning ring, instead of a bubble in the thread (Ram, the same day: "email reading
    // status could be part of that row too"). Pure: `dayHtml(schedule,
    // state, work)`.
    DAY_SHOW: 5,
    _schedule() {
        if (typeof SimpleExperience === 'undefined' || !SimpleExperience.schedule) return null;
        try { this._sched = SimpleExperience.schedule(new Date()); } catch (e) { console.warn('[threads] schedule failed:', e); this._sched = null; }
        return this._sched;
    },
    dayHtml(s, st = {}, work = null) {
        if (!s) return '';
        const esc = v => this.esc(v);
        const today = s.today || [];
        const shown = st._dayMore ? today : today.slice(0, this.DAY_SHOW);
        const row = (r, kind, i) => {
            const h = r.help || {};
            const title = r.open
                ? `<button type="button" class="th-day-title is-link" data-th="${kind}" data-i="${i}" title="${r.open.task || r.open.matter ? 'Open its thread' : r.open.apple ? 'Open in Calendar' : 'Open in Google Calendar'}">${esc(r.title)}</button>`
                : `<span class="th-day-title">${esc(r.title)}</span>`;
            return `<div class="th-day-row"><span class="th-day-time">${esc(r.time || (kind === 'day-open' ? 'Anytime' : 'All day'))}</span><span class="th-day-main">${title}${h.line ? `<span class="th-day-help${h.attn ? ' is-attn' : h.live ? ' is-live' : ''}">${esc(h.line)}</span>` : ''}</span></div>`;
        };
        const chev = '<svg class="th-day-chev" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>';
        const dayOpen = !!st._dayOpen;
        // The heading is the door: the count and the day line are there folded or open.
        let html = `<button type="button" class="th-day-head th-day-toggle" data-th="day-toggle" aria-expanded="${dayOpen}"><span class="th-eyebrow">Today<span class="th-day-count">${today.length || ''}</span>${chev}</span>${s.todayLine ? `<span class="th-day-line">${esc(s.todayLine)}</span>` : today.length ? '' : '<span class="th-day-line">A clear day.</span>'}${work && work.busy ? `<span class="th-day-work"><span class="th-busy" aria-hidden="true"></span>${esc(work.text)}</span>` : ''}</button>`;
        if (!dayOpen) return html;
        html += `${today.length ? shown.map((r, i) => row(r, 'day-open', i)).join('') : '<p class="th-day-empty">A clear day.</p>'}
            ${today.length > this.DAY_SHOW ? `<button type="button" class="th-day-more" data-th="day-more">${st._dayMore ? 'Show less' : `${today.length - this.DAY_SHOW} more today`}</button>` : ''}`;
        const flat = s.flat || [];
        if (flat.length && s.week) {
            const week = s.week;
            const openDate = st._comingDay && week.days.some(d => d.date === st._comingDay) ? st._comingDay : null;
            const next = week.next ? `<div class="th-coming-next"><span class="th-coming-when">${esc(week.next.when)}</span>${flat[week.next.index] && flat[week.next.index].open
                ? `<button type="button" class="th-coming-name" data-th="coming-open" data-i="${week.next.index}">${esc(week.next.title)}</button>`
                : `<span class="th-coming-name">${esc(week.next.title)}</span>`}</div>` : '';
            const strip = week.days.map(d => {
                const label = new Date(`${d.date}T12:00:00`).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
                return `<button type="button" class="th-week-day${d.count ? '' : ' is-clear'}${openDate === d.date ? ' is-open' : ''}" data-th="coming-day" data-id="${esc(d.date)}" aria-pressed="${openDate === d.date}" aria-label="${esc(`${label}: ${d.count ? `${d.count} ${d.count === 1 ? 'thing' : 'things'}` : 'nothing'}`)}"><span class="th-week-dow">${esc(d.dow)}</span><span class="th-week-num">${d.num}</span><span class="th-week-dots" aria-hidden="true">${'<i></i>'.repeat(Math.min(d.count, 4))}</span></button>`;
            }).join('');
            const openDay = openDate ? week.days.find(d => d.date === openDate) : null;
            const rows = !openDay ? '' : openDay.count ? flat.map((r, i) => (r.date === openDate ? row(r, 'coming-open', i) : '')).join('')
                : `<p class="th-day-empty">Nothing on ${esc(new Date(`${openDay.date}T12:00:00`).toLocaleDateString([], { weekday: 'long' }))}.</p>`;
            const open = !!st._comingOpen;
            html += `<div class="th-coming${open ? ' is-open' : ''}">
                <button type="button" class="th-eyebrow th-coming-toggle" data-th="coming-toggle" aria-expanded="${open}">Coming up<span class="th-coming-count">${week.total}</span><svg class="th-coming-chev" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg></button>
                ${open ? `${next}<div class="th-week" role="group" aria-label="The next seven days">${strip}</div>${rows ? `<div class="th-coming-rows">${rows}</div>` : ''}` : ''}
            </div>`;
        }
        return html;
    },
    _dayAct(th, el) {
        const s = this._sched || this._schedule();
        if (!s) return;
        if (th === 'day-open') { SimpleExperience.openScheduleRow(s.today[Number(el.dataset.i)]); return; }
        if (th === 'coming-open') { SimpleExperience.openScheduleRow(s.flat[Number(el.dataset.i)]); return; }
        if (th === 'day-toggle') { this._dayOpen = !this._dayOpen; if (!this._dayOpen) { this._dayMore = false; this._comingOpen = false; this._comingDay = null; } }
        if (th === 'day-more') this._dayMore = !this._dayMore;
        if (th === 'coming-toggle') { this._comingOpen = !this._comingOpen; if (!this._comingOpen) this._comingDay = null; }
        if (th === 'coming-day') this._comingDay = this._comingDay === el.dataset.id ? null : el.dataset.id;
        this._repaint();
    },

    // ── The sheet: a thread over the page you are on (2026-10-10) ───────
    //
    // Ram: "all the chats happening in commitments page or finance pages will
    // use the imessage experience as the underlying chat experience". Every
    // page's box (PageChat) opens its conversation here: the same thread the
    // Threads page shows, as a bottom sheet over the page (the 2026-10-09
    // shape), with "All threads" and the record's own page one tap away.
    // The Chats page keeps the full chat.

    openSheet(key, { text = '', title = '', onClose = null } = {}) {
        if (!key || typeof document === 'undefined') return false;
        this.mount();
        if (!this._sheetEl) {
            const wrap = document.createElement('div');
            wrap.className = 'th-sheet-wrap';
            wrap.hidden = true;
            wrap.innerHTML = '<div class="th-sheet-backdrop" data-th="close"></div><section class="th-sheet th-thread" role="dialog" aria-modal="true" aria-label="Conversation"></section>';
            document.body.append(wrap);
            this._wireHost(wrap);
            this._sheetEl = wrap;
        }
        if (this._sheet && this._sheet.key !== key) this.closeSheet();
        this._sheet = { key, title, onClose };
        this._sheetEl.hidden = false;
        document.body.classList.add('th-sheet-open');
        this._cards = null;
        this.paintSheet();
        const t = this._sheetEl.querySelector('.th-compose textarea');
        if (t) t.focus();
        if (text) this.send(key, text);
        return true;
    },
    paintSheet() {
        if (!this._sheet || !this._sheetEl) return;
        this._cards = null;
        const row = this.rowFor(this._sheet.key, Date.now(), this._sheet.title);
        if (!row) { this.closeSheet(); return; }
        this._markSeen(row.key, row.at);
        this.paintThread(this._sheetEl.querySelector('.th-sheet'), row, { sheet: true });
    },
    closeSheet() {
        if (!this._sheet) return;
        const { onClose } = this._sheet;
        this._sheet = null;
        if (this._sheetEl) this._sheetEl.hidden = true;
        document.body.classList.remove('th-sheet-open');
        if (onClose) { try { onClose(); } catch (e) { console.warn('[threads] onClose failed:', e); } }
    },

    /** The original message as a small attachment under its bubble: what it is, from whom, where it opens. */
    LINK_ICON: {
        email: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m4 7 8 6 8-6"/>',
        imessage: '<path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-3 2V11.5A8.5 8.5 0 0 1 9.5 3h3a8.5 8.5 0 0 1 8.5 8.5Z"/>',
        slack: '<path d="M10 3v18M14 3v18M3 10h18M3 14h18"/>'
    },
    linkCard(x) {
        const via = this.LINK_ICON[x.via] ? x.via : 'email';
        const what = via === 'imessage' ? 'Text' : via === 'slack' ? 'Slack message' : 'Email';
        const where = via === 'imessage' ? 'Open in Messages' : via === 'slack' ? 'Open in Slack' : 'Open in Gmail';
        return `<button type="button" class="th-link" data-th="source" data-id="${this.esc(x.id)}" title="${this.esc(where)}">
                <span class="th-link-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${this.LINK_ICON[via]}</svg></span>
                <span class="th-link-text"><span class="th-link-title">${this.esc(what)}${x.from ? ` from ${this.esc(x.from)}` : ''}</span><span class="th-link-where">${this.esc(where)}</span></span>
                <svg class="th-link-go" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17 17 7M9 7h8v8"/></svg></button>`;
    },

    // ── The info page (docs/SENDERS.md M3) ─────────────────────────────
    //
    // A sender's page, like a contact's info in Messages: what it is, what
    // "all good" means, what is coming up, what the mail said that a person
    // looks up, every item in it (each opens its own page), and Archive.
    // Changing the name or "all good" is said in the thread, never a form.

    _dateWords(iso, time) {
        if (!iso) return '';
        const d = new Date(`${iso}T12:00:00`);
        const w = d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
        return time ? `${w} at ${this._clock(time)}` : w;
    },
    // ── What a thread is tracking, drawn (docs/THREAD_PANELS.md) ─────────
    //
    // A right drawer that slides over the thread (2026-10-12, by request: it
    // takes more room that way), opened from the head's chart button. ThreadPanels builds
    // the blocks from the members' records (V1, V2); AnswerBlocks draws them
    // exactly as it does in an answer. Read-only (V4): a row's link opens its
    // item. One drawer open at a time, per visit (`_panel` = the thread key).
    panelCtx(now = Date.now()) {
        const today = this._isoDay(now);
        const nextOf = (c, d) => { try { return typeof Commitments !== 'undefined' && Commitments.nextOn ? Commitments.nextOn(c, d) : null; } catch { return null; } };
        const timeOf = (c, d) => { try { return typeof Commitments !== 'undefined' && Commitments.timeOn ? Commitments.timeOn(c, d).time : (c.when && c.when.time); } catch { return null; } };
        return { today, Commitments: typeof Commitments !== 'undefined' ? Commitments : null,
            upcoming: rows => this.senderInfo(rows, today, nextOf, timeOf).upcoming };
    },
    /** The thread's blocks as arranged (V3); `{ arranged: false }` for what it can draw before any arrangement. */
    panelFor(row, { arranged = true } = {}) {
        if (typeof ThreadPanels === 'undefined' || !row) return [];
        try { return ThreadPanels.blocksFor(row, { ...this.panelCtx(), arrangement: arranged ? ThreadPanels.get(row.key) : null }); } catch (e) { console.warn('[threads] panel failed:', e); return []; }
    },
    /** While a drawer is open: the assistant's look at how to arrange it, once per change in what it can draw. */
    _judgePanel(row) {
        if (typeof ThreadPanels === 'undefined' || !row) return;
        const base = this.panelFor(row, { arranged: false });
        ThreadPanels.judge(row, base, this.panelCtx()).then(changed => { if (changed && this._panel === row.key) this._repaint(); }).catch(() => {});
    },
    paintPanel(host, row, blocks) {
        const el = host.querySelector('.th-panel');
        if (!el) return;
        if (!blocks) { el.hidden = true; host._paint.panel = null; return; }
        const AB = typeof AnswerBlocks !== 'undefined' ? AnswerBlocks : null;
        // The view name is a plain word: a stable id (`days:<id>`) is not a view name AnswerBlocks parses.
        const body = AB ? blocks.map((b, i) => AB.render(`block${i}`, { [`block${i}`]: b.block })).join('') : '';
        const html = `<div class="th-panel-head"><span class="th-panel-title">${this.esc(row.title)}</span>
                <button type="button" class="th-info" data-th="panel" title="Close" aria-label="Close">${'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>'}</button></div>
            <div class="th-panel-body">${body}<p class="th-panel-note">${this.esc(this.panelNote(typeof ThreadPanels !== 'undefined' ? ThreadPanels.get(row.key) : null))}</p></div>`;
        if (host._paint.panel !== html) {
            el.innerHTML = html; host._paint.panel = html;
            this._judgePanel(row);
            if (typeof ThreadPanels !== 'undefined') ThreadPanels.touch(row);
        }
        el.hidden = false;
    },
    /** The drawer's last line: who arranged it, and that words change it. Pure. */
    panelNote(arr) {
        const by = arr && arr.by === 'you' ? 'Arranged the way you asked.' : arr && arr.by === 'nenva' ? 'Arranged by nenva.' : '';
        return `Drawn from what nenva keeps for this thread.${by ? ` ${by}` : ''} To change what it shows, say it in the thread.`;
    },
    /** Open a thread with its drawer open (a record's door: an account, a strategy, Your money). */
    openPanel(key) { this._panel = key; this._info = null; this.open(key); },
    togglePanel(key) { this._panel = this._panel === key ? null : key; this._repaint(); },

    infoFor(row, now = Date.now()) {
        const today = this._isoDay(now);
        const nextOf = (c, d) => { try { return typeof Commitments !== 'undefined' && Commitments.nextOn ? Commitments.nextOn(c, d) : null; } catch { return null; } };
        const timeOf = (c, d) => { try { return typeof Commitments !== 'undefined' && Commitments.timeOn ? Commitments.timeOn(c, d).time : (c.when && c.when.time); } catch { return null; } };
        return this.senderInfo(row.memberRows || [], today, nextOf, timeOf);
    },
    paintInfo(host, row, { sheet = false } = {}) {
        const s = row.rec;
        const info = this.infoFor(row);
        const icon = d => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
        const chev = icon('<path d="m9 6 6 6-6 6"/>');
        const itemRow = it => `<button type="button" class="th-info-row" data-th="item" data-key="${this.esc(it.key)}">
                <span class="th-info-row-main"><span class="th-info-row-title">${this.esc(it.title)}</span>${it.status || it.facts ? `<span class="th-info-row-sub">${this.esc(it.status || it.facts)}</span>` : ''}</span>${chev}</button>`;
        const section = (title, body) => body ? `<section class="th-info-sec"><h3>${title}</h3><div class="th-info-card">${body}</div></section>` : '';
        const facts = info.facts.map(f => `<div class="th-info-fact"><span class="th-info-fact-label">${this.esc(f.label)}</span><span class="th-info-fact-value">${this.esc(f.value)}</span><span class="th-info-fact-from">${this.esc(f.from)}</span></div>`).join('');
        // What the person told nenva about it (M5), each removable (forget_sender_fact is the same act).
        const told = (Array.isArray(s.facts) ? s.facts : []).slice().reverse().map(f => `<div class="th-info-fact th-info-told"><span class="th-info-fact-value">${this.esc(f.text)}</span>
                <button type="button" class="th-info-forget" data-th="fact-forget" data-id="${this.esc(s.id)}" data-fact="${this.esc(f.id)}" title="Remove" aria-label="Remove">${icon('<path d="M6 6l12 12M18 6 6 18"/>')}</button></div>`).join('');
        // Everything else nenva knows about it, from the one reader (M8).
        const k = typeof SenderKnows !== 'undefined' ? SenderKnows.of(s.id) : null;
        const day = iso => iso ? new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' }) : '';
        const x = icon('<path d="M6 6l12 12M18 6 6 18"/>');
        const decisions = k ? k.decisions.map(d => `<div class="th-info-fact th-info-told"><span class="th-info-fact-value">${this.esc(d.text)}<span class="th-info-fact-from">On ${this.esc(d.on)} · ${this.esc(day(d.at))}</span></span></div>`).join('') : '';
        const updates = k ? k.updates.map(u => `<div class="th-info-fact th-info-told"><span class="th-info-fact-value">${this.esc(u.text)}<span class="th-info-fact-from">${this.esc(day(u.at))} · ${this.esc(u.on)}${u.by === 'nenva' ? ' · nenva' : ''}</span></span></div>`).join('') : '';
        const watching = k ? [
            ...k.watching.notes.map(n => `<div class="th-info-fact th-info-told"><span class="th-info-fact-value">${this.esc(n.text)}<span class="th-info-fact-from">nenva's note · ${this.esc(day(n.at))}</span></span></div>`),
            ...(k.watching.lookAgain ? [`<div class="th-info-fact th-info-told"><span class="th-info-fact-value">Looking again on ${this.esc(this._dateWords(k.watching.lookAgain))}</span></div>`] : []),
            ...k.routines.map(r => `<div class="th-info-fact th-info-told"><button type="button" class="th-info-link" data-th="routine" data-id="${this.esc(r.id)}">${this.esc(r.title)}<span class="th-info-fact-from">Routine${r.last ? ` · ${this.esc(day(r.last.at))}: ${this.esc(r.last.line)}` : ''}</span></button>
                <button type="button" class="th-info-forget" data-th="unlink" data-kind="routine" data-id="${this.esc(s.id)}" data-ref="${this.esc(r.id)}" title="Detach" aria-label="Detach">${x}</button></div>`)
        ].join('') : '';
        const accounts = k ? (k.accounts || []).map(a => `<div class="th-info-fact th-info-told"><button type="button" class="th-info-link" data-th="panel">${this.esc(a.title)}<span class="th-info-fact-from">${/^spending:/.test(a.id) ? 'Bank or card' : 'Investments'}</span></button>
                <button type="button" class="th-info-forget" data-th="unlink" data-kind="account" data-id="${this.esc(s.id)}" data-ref="${this.esc(a.id)}" title="Detach" aria-label="Detach">${x}</button></div>`).join('') : '';
        const docs = k ? k.documents.map(d => `<div class="th-info-fact th-info-told"><button type="button" class="th-info-link" data-th="doc" data-id="${this.esc(d.id)}">${this.esc(d.title)}</button>
                <button type="button" class="th-info-forget" data-th="unlink" data-kind="doc" data-id="${this.esc(s.id)}" data-ref="${this.esc(d.id)}" title="Detach" aria-label="Detach">${x}</button></div>`).join('') : '';
        const jobs = k ? k.jobs.map(j => `<button type="button" class="th-info-row" data-th="job" data-id="${this.esc(j.id)}"><span class="th-info-row-main"><span class="th-info-row-title">${this.esc(j.goal)}</span><span class="th-info-row-sub">${this.esc({ running: 'Working', queued: 'Waiting to start', awaiting_user: 'Needs you', paused: 'Paused', failed: 'Stopped', done: 'Done' }[j.status] || j.status)}${j.note ? ` · ${this.esc(j.note)}` : ''}</span></span>${chev}</button>`).join('') : '';
        const settled = info.settled.length ? `<details class="th-info-settled"><summary>Settled · ${info.settled.length}</summary>${info.settled.map(itemRow).join('')}</details>` : '';
        const archived = s.state === 'archived';
        const html = `<header class="th-head th-info-head">
                <button type="button" class="th-head-link" data-th="info-back">${sheet ? 'Back' : 'Back to thread'}</button>
                ${sheet ? `<button type="button" class="th-info" data-th="close" title="Close" aria-label="Close">${icon('<path d="M6 6l12 12M18 6 6 18"/>')}</button>` : ''}</header>
            <div class="th-info-body">
                <div class="th-info-top">${this.avatarOf(row).replace('th-avatar ', 'th-avatar th-avatar-big ')}
                    <h2 class="th-info-name">${this.esc(s.name)}</h2>
                    ${s.allGood ? `<p class="th-info-good">${this.esc(this._sentence(s.allGood))}</p>` : '<p class="th-info-good is-empty">No "all good" sentence yet.</p>'}
                    ${s.builtIn ? '' : `<div class="th-info-says">
                        <button type="button" class="th-chip" data-th="say" data-text="Call it ">Rename</button>
                        <button type="button" class="th-chip" data-th="say" data-text="For this, all good means ">Change what all good means</button>
                        <button type="button" class="th-chip" data-th="say" data-text="Attach my document ">Attach a document</button>
                    </div>`}</div>
                ${section('What you told nenva', told)}
                ${section('Decisions', decisions)}
                ${section('From your mail', facts)}
                ${section('Jobs', jobs)}
                ${section('What nenva is watching', watching)}
                ${section('Accounts', accounts)}
                ${section('Documents', docs)}
                ${section('Latest updates', updates)}
                ${section(info.open.length ? 'Open' : '', info.open.map(itemRow).join(''))}
                ${settled ? `<section class="th-info-sec">${settled}</section>` : ''}
                ${s.builtIn ? '' : `<section class="th-info-sec th-info-end">
                    <button type="button" class="th-info-archive" data-th="archive" data-id="${this.esc(s.id)}">${archived ? 'Bring back' : 'Archive'}</button>
                    <p class="th-info-note">${archived ? 'Archived: kept with its history; nenva is not looking at it.' : 'Archiving keeps everything; nenva stops looking at it.'}</p>
                </section>`}
            </div>`;
        host.dataset.id = row.key;
        host.dataset.info = '1';
        if (host._infoHtml !== html) { host.innerHTML = html; host._infoHtml = html; host._paint = {}; }
    },
    /** nenva's info page: its conversations, newest first, and New conversation (M4). */
    NENVA_LIST_MAX: 200,
    paintNenvaInfo(host, row, { sheet = false } = {}) {
        const icon = d => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
        const current = row.conv ? row.conv.id : '';
        const q = String(this._nenvaQuery || '').trim().toLowerCase();
        const all = this.generalConvs();
        const list = all.filter(c => !q || `${c.title || ''} ${(c.messages || []).map(m => typeof m.content === 'string' ? m.content : '').join(' ')}`.toLowerCase().includes(q)).slice(0, this.NENVA_LIST_MAX);
        const last = c => { const m = (c.messages || []).filter(x => x && ['user', 'assistant'].includes(x.role) && typeof x.content === 'string' && x.content.trim()).pop(); return m ? (m.role === 'user' ? 'You: ' : '') + this._plain(m.content) : ''; };
        const rows = list.map(c => `<button type="button" class="th-info-row${c.id === current ? ' is-current' : ''}" data-th="nenva-pick" data-id="${this.esc(c.id)}">
                <span class="th-info-row-main"><span class="th-info-row-title">${this.esc(c.title || 'Conversation')}</span><span class="th-info-row-sub">${this.esc(last(c).slice(0, 140))}</span></span>
                <span class="th-info-row-time">${this.esc(this.timeLabel(this._t(c.updatedAt || c.createdAt)))}</span></button>`).join('');
        const html = `<header class="th-head th-info-head">
                <button type="button" class="th-head-link" data-th="info-back">${sheet ? 'Back' : 'Back to thread'}</button>
                ${sheet ? `<button type="button" class="th-info" data-th="close" title="Close" aria-label="Close">${icon('<path d="M6 6l12 12M18 6 6 18"/>')}</button>` : ''}</header>
            <div class="th-info-body">
                <div class="th-info-top">${this.avatarOf(row).replace('th-avatar ', 'th-avatar th-avatar-big ')}
                    <h2 class="th-info-name">nenva</h2>
                    <p class="th-info-good">Ask me anything here. Each thing I look after for you has its own thread.</p>
                    <div class="th-info-says"><button type="button" class="th-chip is-primary" data-th="nenva-new">New conversation</button><button type="button" class="th-chip" data-th="nenva-private">Private conversation</button></div></div>
                <section class="th-info-sec"><div class="th-info-card">
                    <button type="button" class="th-info-row" data-th="nenva-chats"><span class="th-info-row-main"><span class="th-info-row-title">Routines and all chats</span><span class="th-info-row-sub">Your routines, and every chat as a list</span></span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg></button>
                </div></section>
                <section class="th-info-sec">
                    <h3>Conversations${all.length ? ` · ${all.length}` : ''}</h3>
                    ${all.length > 8 ? `<input type="search" class="th-search th-nenva-search" placeholder="Search conversations" aria-label="Search conversations" value="${this.esc(this._nenvaQuery || '')}">` : ''}
                    ${rows ? `<div class="th-info-card">${rows}</div>` : `<p class="th-empty">${q ? 'Nothing matches.' : 'No conversations yet.'}</p>`}
                </section>
            </div>`;
        host.dataset.id = row.key;
        host.dataset.info = '1';
        if (host._infoHtml !== html) {
            const had = document.activeElement && document.activeElement.classList.contains('th-nenva-search');
            host.innerHTML = html; host._infoHtml = html; host._paint = {};
            if (had) { const box = host.querySelector('.th-nenva-search'); if (box) { box.focus(); box.setSelectionRange(box.value.length, box.value.length); } }
        }
    },

    /** Back to the thread, with the start of a sentence in the composer. */
    sayInThread(host, text) {
        this._info = null;
        this._repaint();
        const box = (host && host.isConnected ? host : document).querySelector('.th-compose textarea');
        if (!box) return;
        box.value = text;
        box.focus();
        box.setSelectionRange(text.length, text.length);
    },
    archiveSender(id) {
        if (typeof Senders === 'undefined' || !id) return;
        const s = Senders.get(id);
        if (!s) return;
        if (s.state === 'archived') { Senders.unarchive(id); this._repaint(); return; }
        Senders.archive(id);
        this._info = null;
        if (this._open === id) this._open = null;
        if (this._sheet && this._sheet.key === id) this.closeSheet();
        this._repaint();
        if (typeof UIUtils !== 'undefined') UIUtils.showToast(`${s.name} archived. Its history is kept.`, 'success', this.UNDO_MS, {
            actionLabel: 'Undo', onAction: () => { Senders.unarchive(id); this._open = id; this._repaint(); }
        });
    },

    ROUTINE_NEWS: 5,
    /** A linked routine's latest results, as thread items (M8). */
    _routineNews(id) {
        if (typeof NotePrompts === 'undefined' || !NotePrompts.runs) return [];
        try {
            const r = NotePrompts.get(id);
            return NotePrompts.runs(id).filter(x => !x.error).slice(0, this.ROUTINE_NEWS).map(x => {
                const line = (x.look && x.look.headline) || String(x.content || '').split('\n').find(t => t.trim()) || '';
                return { at: this._t(x.createdAt), side: 'them', kind: 'chat', md: true, text: this._sentence(line.replace(/^#+\s*/, '').slice(0, 280)), about: (r && r.title) || 'Routine', routine: id };
            });
        } catch { return []; }
    },
    /** Detach a document or a routine from a sender (M8), with Undo. */
    unlink(id, kind, ref) {
        if (typeof Senders === 'undefined') return;
        const gone = Senders.unlink(id, kind, ref);
        if (!gone) return;
        this._repaint();
        if (typeof UIUtils !== 'undefined') UIUtils.showToast('Detached.', 'success', this.UNDO_MS, {
            actionLabel: 'Undo', onAction: () => { Senders.link(id, gone); this._repaint(); }
        });
    },
    /** Remove one thing the person told nenva about a sender (M5), with Undo. */
    forgetFact(id, factId) {
        if (typeof Senders === 'undefined' || !id || !factId) return;
        const gone = Senders.forgetFact(id, factId);
        if (!gone) return;
        this._repaint();
        if (typeof UIUtils !== 'undefined') UIUtils.showToast('Removed.', 'success', this.UNDO_MS, {
            actionLabel: 'Undo', onAction: () => { Senders.undoFact(id, { forgotten: gone }); this._repaint(); }
        });
    },

    // ── Acting ──────────────────────────────────────────────────────────

    /** Just connected and nothing said yet: worth a look every few seconds until reading starts. */
    _readingSoon() {
        try {
            return typeof AccountsManager !== 'undefined' && AccountsManager.getAll().some(a => a && a.services && a.services.mail && a.connectedAt && Date.now() - Date.parse(a.connectedAt) < 10 * 60000);
        } catch { return false; }
    },
    _repaint() {
        if (typeof AppManager !== 'undefined' && AppManager.currentApp === this.APP) this.render();
        if (this._sheet) this.paintSheet();
    },
    async send(key, text) {
        if (typeof SimpleExperience === 'undefined' || typeof AgentService === 'undefined') return;
        if (!key || this._sending.has(key)) return;
        const row = this.rowFor(key, Date.now(), this._sheet && this._sheet.key === key ? this._sheet.title : '');
        if (!row) return;
        const conv = row.conv || (row.type === 'nenva' ? this._makeGeneral(text) : this._make(key, row.stub));
        if (!conv) return;
        if (row.type === 'nenva') this._setNenvaPick(conv.id);
        else if (!conv.texting) { conv.texting = true; AgentService._saveConversations(); }
        // A thing's thread starts its turns with the tools a thing needs loaded (2026-10-12: with
        // none loaded, a turn answered "Sent." having sent nothing). The model still loads more itself.
        if (row.type !== 'nenva') {
            const had = new Set(conv.scopedDomains || []);
            const want = this.THREAD_GROUPS.filter(g => !had.has(g));
            if (want.length) { conv.scopedDomains = [...had, ...want]; AgentService._saveConversations(); }
        }
        // Opened from one thing in a sender or a step of a goal (its page's box): that is what the
        // person is most likely talking about (ThingCapture reads it, briefly).
        if (key !== row.key && (row.members || []).includes(key)) { conv.focus = { key, at: Date.now() }; AgentService._saveConversations(); }
        this._sending.add(key);
        const p = AgentService.sendMessage(text, null, { convId: conv.id });
        // sendMessage puts the person's words on the conversation at once.
        setTimeout(() => this._repaint(), 30);
        try {
            const res = await p;
            if (res && res.type === 'error' && typeof UIUtils !== 'undefined') UIUtils.showToast(res.content || 'That did not go through', 'error');
        } catch (e) {
            console.warn('[threads] send failed:', e);
            if (typeof UIUtils !== 'undefined') UIUtils.showToast('That did not go through', 'error');
        } finally {
            this._sending.delete(key);
            this._repaint();
        }
    },
    /**
     * The intro's answers (S3). Keep is one tap. Rename and Fold into are
     * said in the thread: the composer opens with the start of the sentence
     * and the assistant does it (rename_sender / fold_senders), so the
     * person never meets a form.
     */
    senderAct(id, act, host) {
        if (typeof Senders === 'undefined' || !id) return;
        if (act === 'keep') { Senders.confirm(id); this._repaint(); return; }
        const t = host && host.querySelector('.th-compose textarea');
        if (!t) return;
        const s = Senders.get(id);
        t.value = act === 'rename' ? 'Call it ' : `Put ${s ? s.name : 'this'} together with `;
        t.focus();
        t.setSelectionRange(t.value.length, t.value.length);
    },
    /** Back from a page opened here returns to this thread or its info page, named. */
    _wayBack() {
        const info = this._info, open = this._open;
        const s = /^sender:/.test(String(info || open || '')) && typeof Senders !== 'undefined' ? Senders.get(info || open) : null;
        return { label: s ? s.name : 'Threads', go: () => { this._info = info; if (open) this._open = open; this.open(); } };
    },
    openDetails(key) {
        if (/^sender:/.test(key) || key === 'nenva') { this._info = key; this._repaint(); return; }
        const t = /^task:(.+)$/.exec(key);
        if (t && typeof CommitmentsPage !== 'undefined') { CommitmentsPage.open(t[1], { back: this._wayBack() }); return; }
        if (/^matter:/.test(key) && typeof MatterPage !== 'undefined') { MatterPage.open(key); return; }
        if (key === 'page:commitments' && typeof CommitmentsPage !== 'undefined') { CommitmentsPage.open(); return; }
    },

    onClick(e) {
        const el = e.target.closest('[data-th]');
        if (!el) return;
        const { th, id } = el.dataset;
        const key = el.closest('.th-thread')?.dataset.id || this._open;
        if (th === 'delete') { e.stopPropagation(); this.remove(id || key); return; }
        if (th === 'open') { this._info = null; const was = (this._rows || []).find(r => r.key === id); this._sticky = was && was.unread ? id : null; this._open = id; this.render(); const t = document.querySelector(`#${this.APP}-view .th-compose textarea`); if (t) t.focus(); return; }
        if (th === 'close') { this.closeSheet(); return; }
        if (th === 'panel' && key) {
            // From the info page (an attached account): back to the thread with its drawer open.
            if (this._info === key) { this._info = null; this._panel = key; this._repaint(); } else this.togglePanel(key);
            return;
        }
        if (['day-toggle', 'day-open', 'coming-open', 'day-more', 'coming-toggle', 'coming-day'].includes(th)) { this._dayAct(th, el); return; }
        if (th === 'sender') { this.senderAct(el.dataset.id, el.dataset.act, el.closest('.th-thread')); return; }
        if (th === 'all') { const k = key; this.closeSheet(); this.open(k); return; }
        if (th === 'details' && key) {
            if (/^sender:/.test(key) || key === 'nenva') { this.openDetails(key); return; }   // the info page opens in place, in the sheet too
            const inSheet = !!el.closest('.th-sheet'); if (inSheet) this.closeSheet(); this.openDetails(key); return;
        }
        if (th === 'info-back') { this._info = null; this._repaint(); return; }
        if (th === 'item' && el.dataset.key) { const inSheet = !!el.closest('.th-sheet'); if (inSheet) this.closeSheet(); this.openDetails(el.dataset.key); return; }
        if (th === 'say') { this.sayInThread(el.closest('.th-thread'), el.dataset.text || ''); return; }
        if (th === 'archive') { this.archiveSender(el.dataset.id); return; }
        if (th === 'fact-forget') { this.forgetFact(el.dataset.id, el.dataset.fact); return; }
        // M8: what a sender links to, and its jobs.
        if (th === 'unlink') { this.unlink(el.dataset.id, el.dataset.kind, el.dataset.ref); return; }
        if (th === 'doc') { if (typeof DocumentsPage !== 'undefined') DocumentsPage.showDocument('file', el.dataset.id); return; }
        if (th === 'routine') { if (typeof SimpleExperience !== 'undefined') SimpleExperience.openStanding(el.dataset.id); return; }
        if (th === 'job') { if (typeof SimpleExperience !== 'undefined') SimpleExperience.openJob(el.dataset.id); return; }
        // Chats left the nav (M7): routines and every chat as a list, and a private chat, are reached from nenva's info page.
        if (th === 'nenva-chats') { if (typeof AppManager !== 'undefined') AppManager.openApp('conversations'); return; }
        if (th === 'nenva-private') {
            if (typeof AppManager === 'undefined' || typeof AgentUI === 'undefined') return;
            AppManager.openApp('agent');
            if (AppManager.currentApp === 'agent' && !(typeof PrivateChat !== 'undefined' && PrivateChat.isPrivate(AgentService.conversations.find(c => c.id === AgentService.activeConversationId)))) AgentUI.startPrivateChat();
            return;
        }
        if (th === 'nenva-new') { if (el.closest('.th-sheet')) this.closeSheet(); this.newNenvaConversation(); return; }
        if (th === 'nenva-pick' && el.dataset.id) { if (el.closest('.th-sheet')) this.closeSheet(); this.pickNenvaConversation(el.dataset.id); return; }
        if (th === 'source' && typeof MatterPage !== 'undefined') { MatterPage.openMessage(id); return; }
        if (th === 'act' && typeof SimpleExperience !== 'undefined') {
            Promise.resolve(SimpleExperience.cardAct(el.dataset.key, el.dataset.act)).finally(() => setTimeout(() => this._repaint(), 50));
        }
    }
};

// A sender is linkable from an answer: anjadhe://sender/<id> opens its thread (M4, the hand-off's way back).
if (typeof RecordLinks !== 'undefined' && RecordLinks.register) {
    RecordLinks.register('sender', {
        label: 'thread', hint: 'one of the things nenva looks after, with its own thread; use its id from list_senders',
        exists: id => (typeof Senders !== 'undefined' ? !!(Senders.get(id) && !Senders.get(id).builtIn) : null),
        open: id => ThreadsPage.open(Senders.get(id) ? Senders.get(id).id : id)
    });
}

if (typeof module !== 'undefined') module.exports = ThreadsPage;
