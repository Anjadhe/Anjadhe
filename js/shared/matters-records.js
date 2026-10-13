'use strict';
// Shared validated record operations. Hosts supply only load/save and post-commit effects.
const MatterRecords = Object.freeze({
    /** The emails and texts filed on a folder (its other sources are the person's own words). */
    messagesOf(m) { return ((m && m.sources) || []).filter(s => !s.kind || (this.SOURCES[s.kind] || {}).message); },
    _prompt(f, cands, now = Date.now(), events = [], tasks = [], second = false, relook = false, instr = []) {
        const today = new Date(now).toLocaleDateString([], { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
        const folder = (m, i) => `[M${i + 1}] (${m.kind}${m.state !== 'open' ? `, ${m.state}` : ''}) ${m.title}${m.status ? ` — ${m.status}` : ''}${m.when && m.when.date ? ` — ${m.when.date}${m.when.time ? ' ' + m.when.time : ''}` : ''}${m.next && m.next.state === 'open' ? ` — next: ${m.next.what}${m.next.by ? ` by ${m.next.by}` : ''}` : ''} — ${this.messagesOf(m).length} message(s), latest from ${(this.messagesOf(m)[this.messagesOf(m).length - 1] || {}).from || 'unknown'}: "${String((m.sources[m.sources.length - 1] || {}).summary || '').slice(0, 140)}"${m.calendar ? ` — on their calendar as "${m.calendar.title}"` : ''}`;
        let prefs = '';
        try { if (typeof EmailApp !== 'undefined' && EmailApp.emailPreferenceLines) { const p = EmailApp.emailPreferenceLines(); if (p && p.length) prefs = `\nWHAT THE PERSON HAS TOLD YOU ABOUT THEIR MAIL (their word outranks your own sense of what is worth their attention: for a message they said to ignore, skip or not show, answer "tell": "file" and "next": null, or "none"; never raise it because it carries a date or says overdue)\n${p.join('\n')}\n`; } } catch { /* none */ }
        // Their standing instructions about mail and texts (Instructions, I2):
        // routines this call reads instead of a second reader of the mailbox.
        if (instr.length && typeof Instructions !== 'undefined') prefs += `\nTHEIR STANDING INSTRUCTIONS ABOUT MAIL AND TEXTS (they asked for these; when this message is what one is about, follow it: keep it in a folder and tell them as it asks, "now" when it says right away)\n${Instructions.lines(instr).join('\n')}\n`;
        return `Today is ${today}.

THE MESSAGE (${(this.SOURCES[f.source] || this.SOURCES.email).label})
From: ${f.meta.name || ''} <${f.meta.address || ''}>
Date: ${f.at || ''}
${f.source === 'slack' ? `Slack coverage is incomplete. The excerpt is evidence, not the entire conversation. This is ${f.own ? "the person's own message" : "a message from someone else"}. A reply or missing context alone does not settle an obligation. For change done/cancelled, also return resolution_quote: an exact phrase from this excerpt explicitly establishing completion or cancellation. Never infer that a Slack sender is the person's manager.\n` : ''}
Subject: ${f.subject}
What was read in it: ${f.summary}${f.amount ? ` | amount ${f.amount}` : ''}${f.dates.length ? ` | dates ${f.dates.join(', ')}` : ''}${f.actions.length ? ` | asks: ${f.actions.join('; ')}` : ''}${f.reservation ? ` | booking: ${JSON.stringify(f.reservation)}` : ''}
Body:
${f.body || '(none)'}
${f.links.length ? `\nLINKS IN IT\n${f.links.map((u, i) => `[${i + 1}] ${u}`).join('\n')}\n` : ''}
${events.length ? `THEIR CALENDAR ON THOSE DAYS\n${events.map((e, i) => `[C${i + 1}] ${e.title} — ${e.when}`).join('\n')}\n\n` : ''}${tasks.length ? `THEIR OPEN TASKS AROUND THEN\n${tasks.map((t, i) => `[T${i + 1}] ${t.title}${t.when ? ` — ${t.when}` : ''}`).join('\n')}\n\n` : ''}THINGS YOU ARE ALREADY KEEPING TRACK OF THAT MIGHT BE RELATED
${cands.length ? cands.map(folder).join('\n') : '(none)'}
${second ? '\nYou first read this as a NEW thing. Before a new folder is made, look again at the list above (it is longer now): if one of them is the same real thing, even under another name, from another sender or reached another way, answer with that one. Two folders for one thing is the mistake to avoid; answer "new" only if none of them is it.\n' : ''}${relook ? '\nYou passed this over earlier as nothing to keep track of. It carries a date still ahead, an amount, or something asked of the person. Look once more: if it is something they will have to deal with, or would want to find again, keep it (with "tell": "file" if they need not hear about it). Answer "none" again only if you are sure.\n' : ''}${prefs}
You keep one folder per real thing in the person's life (an appointment, a bill, an order, a booking, a subscription or membership, or another thing they have to deal with). Decide what to do with this message. Answer JSON only:
Routine confirmations that the person granted an app access, connected an inbox, signed in or changed a setting ask nothing of them: answer "about": "none", "tell": "file", "next": null. Boilerplate such as "if this wasn't you, review access" is conditional, not evidence that the condition occurred. Never invent a task to review permissions just because a notice offers that link. A confirmed compromise, blocked access or a required recovery step is different: keep that real problem and tell them promptly. Judge the actual message, not security-related vocabulary alone.
Dates on notices describe what already happened; they are not deadlines. The Date header and today's date must never become a next-step deadline. Only a specific, still-outstanding obligation can be "yours". Quote the actual request and any explicit deadline separately; do not quote your generated summary as evidence. Missing deadline or time stays null. Do not schedule a precaution, optional suggestion, or a conditional instruction whose condition is not established.
{"about": ${cands.length ? `the label of the folder in the list above (for example "M1") if it is about one of those exact things (another reminder, a change, a confirmation, a payment of that bill, a delivery of that order; the list may hold things that have nothing to do with this message, and ANOTHER visit to the same place, the NEXT month's bill, another order from the same shop or another appointment on the same day is a new thing, not one of those), "new" if it starts` : `"new" if it starts`} a new thing worth keeping track of (something still ahead or still open, and ALSO something finished that the person would look for again or that moved their money: a receipt or a payment that went through, a refund, a delivery that landed, a trade that executed; for those answer "change": "done", "tell": "file" and "next": null, so it is kept quietly), or "none" if there is nothing anyone would keep (a sign-in code, an ad, a newsletter, a routine statement with nothing to do, a social or marketing notification),
 "kind": "appointment" | "bill" | "order" | "reservation" | "subscription" | "other",
 "title": a short name a person would use, e.g. "Dental cleaning with Dr. Lee", "City Water bill", "Birthday cake from Cold Stone",
 "status": where it stands now, a few words, e.g. "Waiting for you to confirm", "Due Oct 12", "Ready for pickup", "Paid", "Renews Oct 11 at a higher price",
 "change": "new" | "same" (nothing new, just a reminder) | "changed" (a new time, a new amount, a problem) | "done" (paid, delivered, picked up, confirmed, settled) | "cancelled",
 "when": "YYYY-MM-DD" the date it is about (the appointment, the due date, the pickup, the departure) or null, "time": "HH:MM" or null; a day or time the message only OFFERS or proposes (reply 1 for Monday, 2 for Wednesday) is not the date until it is confirmed: keep the folder's date and put the choice in "next",
 "next": null if there is nothing for the person to do, else {"what": the one thing to do, "label": 1 to 3 words for its button, "quote": verbatim sentence from the message requiring this outstanding action, "by": "YYYY-MM-DD" or null, "by_quote": verbatim phrase giving this action's deadline or null, "time": "HH:MM" only if that deadline has an explicit time, else null, "time_quote": verbatim phrase giving that time or null, "how": "reply" (answer the sender) | "link" (do it on a page from LINKS) | "none", "reply": the exact reply if they asked for one (e.g. "C"), "link": number of the link in LINKS, "yours": true if it is real work worth a task (pay, fill in a form, pick up, sign), false for a quick reply or a decision},
${f.links.length ? ` "checkin_link": number of a check-in link in LINKS for a flight, or null,\n` : ''}${events.length ? ` "calendar": the label of the calendar event listed above (for example "C1") if this thing IS that event (the same appointment, booking or meeting), else null,\n` : ''}${tasks.length ? ` "task": the label of the open task listed above (for example "T1") if it is their own to-do for this same thing (e.g. "Call the dentist" for the dentist appointment), else null; when that task IS the next step below, also put "is_task": true inside "next",\n` : ''}${instr.length ? ' "instruction": the label of the standing instruction above that this message is what it is about (for example "I1"), else null,\n' : ''} "tell": "now" only if it cannot wait until tomorrow morning (due today or tomorrow, a change or cancellation to plans, something went wrong, ready to pick up now); "morning" if it is worth telling them today; "file" if they never need to hear about it (receipts, routine reminders of something already known, statements, notices that ask nothing)}
If it is something the person will HAVE to deal with (a date they must keep, a deadline with a consequence, an amount they owe) and you are only unsure whether it is worth their attention, keep it quietly: "new", "tell": "file", "next": null. A quiet folder costs the person nothing; a missed one can. An offer, a sale, an advert or a newsletter is never that, whatever date it carries.
Never invent amounts, dates, times, codes or links.`;
    },
    /**
     * Does the answer "this is about that folder" sit badly with the facts?
     * Arithmetic only: both dated and more than two days apart (unless this
     * message settles it), another hour on the same day with "nothing new",
     * a step or a date being put on a folder already settled, or a settled
     * folder being settled again by a message dated days away from it (the
     * next month's bill, the next renewal: 2026-10-12, the Threads demo eval
     * folded six water bills and three renewals into one folder each, so
     * the drawer had one amount and the look no history). A shared booking
     * code ends the question: it is that thing (a shared number does not: an
     * account number is on every month's bill). Returns the difference in
     * words, or null. Pure.
     */
    disagrees(f, j, m) {
        if (!m || !j) return null;
        const code = f.reservation && f.reservation.confirmationCode;
        if (code && String(m.code || '').toLowerCase() === String(code).toLowerCase()) return null;
        const settles = j.change === 'done' || j.change === 'cancelled';
        const mw = m.when || {};
        if (!settles && j.when && mw.date && this._daysApart(j.when, mw.date) > 2) return `the folder is for ${mw.date} and this message is about ${j.when}`;
        if (j.change === 'same' && j.when && j.when === mw.date && j.time && mw.time && j.time !== mw.time) return `both are on ${j.when}, but the folder is at ${mw.time} and this message says ${j.time}`;
        if (m.state !== 'open' && !settles && (j.next || j.when)) return `the folder is already ${m.state} and this message ${j.next ? 'asks for something new' : `is about ${j.when}`}`;
        // Only a LATER message: one from before the folder's day (a prepayment, a "see you then") is about that same thing.
        const was = mw.date || this._day((m.sources || []).map(s => s.at).filter(Boolean).sort().pop());
        const is = j.when || this._day(f.at);
        const later = was && is && is > was && this._daysApart(was, is) > 2;
        if (m.state !== 'open' && settles && later) return `the folder was already ${m.state} around ${was} and this message is from ${is}`;
        // Another amount, days later: the next bill, the next renewal, the next charge (whatever the folder's state).
        const money = v => { const n = String(v == null ? '' : v).replace(/[^0-9.]/g, ''); return n ? Number(n) : null; };
        const fa = money(f.amount), ma = money(m.amount);
        if (later && fa != null && ma != null && fa !== ma) return `the folder's amount is ${m.amount} and this message, ${this._daysApart(was, is)} days later, says ${f.amount}`;
        return null;
    },
    _describe(m) {
        const msgs = m.sources || [];
        return { id: m.id, title: this.titleOf(m), kind: m.kind, when: m.when && m.when.date, time: m.when && m.when.time, status: m.status || m.state, amount: m.amount || null,
            privacySources: this.privacySources(m),
            from: [...new Set(msgs.map(s => s.from || s.address).filter(Boolean))].slice(0, 3).join(', '), latest: (msgs[msgs.length - 1] || {}).summary || '' };
    },
    _samePrompt(x, y, why) {
        const line = t => `${t.title || 'Untitled'} (${t.kind || 'other'}${t.when ? `, ${t.when}${t.time ? ' ' + t.time : ''}` : ''}${t.status ? `, ${t.status}` : ''}${t.amount ? `, ${t.amount}` : ''})${t.from ? ` — from ${t.from}` : ''}${t.latest ? `; says: ${String(t.latest).slice(0, 220)}` : ''}`;
        return `You keep one folder per real thing in the person's life, and one occurrence is one thing: this bill, this renewal, this visit, this charge. Are these two about the SAME real thing, or two DIFFERENT things?

A: ${line(x)}
B: ${line(y)}
${why ? `\nNote: ${why}.\n` : ''}
The SAME thing: one appointment seen from the office and from its patient portal or reminder service; one bill seen from the biller and from a bank; one order seen from the shop and from the carrier; one visit moved to a new time; one bill and the payment of that same bill.
DIFFERENT things: two visits to the same place (a cleaning and a crown fitting); this month's bill and last month's; the offer for the next term of a policy or membership and the last term's paid renewal; the next charge of a subscription and the last one; two orders from one shop; two appointments on the same day with different people. The same account, policy or customer number is on every one of them and does not make them one thing.

Answer JSON only: {"same": true} or {"same": false}`;
    },
    CANDIDATES_MAX: 8,
    CHANGES: ["new", "same", "changed", "done", "cancelled"],
    KINDS: ["appointment", "bill", "order", "reservation", "subscription", "other"],
    NEAR_MAX: 6,
    // Where an observation can come from. `message` sources are mail and
    // texts (a sender, a thread, something to open); the rest are the
    // person's own words and acts.
    // `tag` is the model call's source tag (its privacy class and routing).
    SOURCES: {"email": {"label": "an email", "message": true, "tag": "email-matter"}, "imessage": {"label": "a text", "message": true, "tag": "imessage-matter"}, "slack": {"label": "a Slack conversation excerpt", "message": true, "tag": "slack-matter", "bounded": true}, "chat": {"label": "something the person told you in a chat", "message": false, "tag": "matter-own"}, "commitment": {"label": "a task the person wrote for themselves", "message": false, "tag": "matter-own"}, "calendar": {"label": "an event on the person's own calendar", "message": false, "tag": "matter-own"}},
    TELL: ["now", "morning", "file"],
    WINDOW_DAYS: 120,
    // Derived matter text keeps its source restrictions after sources are
    // joined, invalidated or removed. Only the main bounded filing service
    // supplies _inference; the ordinary renderer route cannot fall back.
    privacySources(m) {
        return [...new Set([...(m?.privacySources || []), ...(m?.sources || []).map(s => s.kind).filter(Boolean)])];
    },
    // ── Facts ───────────────────────────────────────────────────────────
    _day(v) { const s = String(v || '').slice(0, 10); return /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(`${s}T12:00:00`)) ? s : null; },
    _iso(t) { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; },
    /** Order / confirmation / invoice numbers and the like: identity facts, for finding related folders. */
    identifiers(text) {
        const ids = new Set();
        const t = String(text || '');
        for (const m of t.matchAll(/\b(?:order|invoice|account|acct|reference|ref|confirmation|booking|reservation|policy|claim|case|ticket|tracking|statement|bill)\s*(?:number|no\.?|#|id|code)?\s*[:#]?\s*#?([a-z0-9][a-z0-9-]{3,})/gi)) {
            if (/\d/.test(m[1])) ids.add(m[1].toLowerCase());
        }
        for (const m of t.matchAll(/#\s?([a-z0-9-]*\d[a-z0-9-]{3,})/gi)) ids.add(m[1].toLowerCase());
        for (const m of t.matchAll(/\b(1Z[0-9A-Z]{16}|\d{8,22})\b/g)) ids.add(m[1].toLowerCase());
        return [...ids];
    },
    links(body) {
        const out = [];
        for (const m of String(body || '').matchAll(/https?:\/\/[^\s<>"')\]]+/g)) {
            const u = m[0].replace(/[.,;:]+$/, '');
            if (!out.includes(u) && !/unsubscribe|preferences|privacy|\.(png|jpe?g|gif)(\?|$)/i.test(u)) out.push(u);
            if (out.length >= 8) break;
        }
        return out;
    },
    /**
     * An observation from anything that is not mail: the same record `facts`
     * returns, so everything downstream reads one shape. `own` is true when
     * these are the person's own words or act. Pure.
     */
    observation({ id, source, at = null, text = '', title = '', summary = '', dates = [], own = true, who = null } = {}) {
        const body = String(text || '').slice(0, 2500);
        return {
            id: String(id), at, source: this.SOURCES[source] ? source : 'chat', own: !!own,
            meta: { name: who || (own ? 'You' : null), address: null, thread: null, imessage: false },
            subject: String(title || ''), body, summary: String(summary || '').slice(0, 300), type: 'general', amount: null,
            dates: (dates || []).map(d => this._day(d)).filter(Boolean), actions: [], reservation: null,
            ids: this.identifiers(`${title}\n${body}`), links: this.links(body)
        };
    },
    /** Folders that might be related, by fact: same sender or chat, a shared number, the same thread, an open one on the same day. Pure. */
    candidates(f, matters, now = Date.now()) {
        const since = now - this.WINDOW_DAYS * 86400000;
        const today = this._iso(now);
        const live = (matters || []).filter(m => m && (m.state === 'open' || Date.parse(m.updatedAt || 0) >= since || (m.when && m.when.date >= today)));
        const days = new Set([...(f.dates || []), this._day(f.reservation && f.reservation.start)].filter(Boolean));
        const score = m => {
            let s = 0;
            if (f.ids.some(id => (m.ids || []).includes(id))) s += 4;
            if (f.meta.thread && (m.sources || []).some(x => x.thread === f.meta.thread)) s += 3;
            // A root message can acquire a thread only after its first read.
            // Keep the conversation as a weak candidate signal so a later
            // threaded reply can still find the original unthreaded request.
            if (f.slack && (m.sources || []).some(x => x.slack?.workspaceId === f.slack.workspaceId
                && x.slack?.userId === f.slack.userId && x.slack?.channelId === f.slack.channelId)) s += 1;
            if (f.meta.address && (m.sources || []).some(x => x.address === f.meta.address)) s += 2;
            if (f.reservation && f.reservation.confirmationCode && String(m.code || '').toLowerCase() === String(f.reservation.confirmationCode).toLowerCase()) s += 4;
            // The same day as an open folder: weakest, but the only fact an
            // office's email and its text share. The assistant decides.
            if (m.state === 'open' && m.when && m.when.date && days.has(m.when.date)) s += 1;
            return s;
        };
        return live.map(m => ({ m, s: score(m) })).filter(x => x.s > 0)
            .sort((a, b) => b.s - a.s || Date.parse(b.m.updatedAt || 0) - Date.parse(a.m.updatedAt || 0))
            .slice(0, this.CANDIDATES_MAX).map(x => x.m);
    },
    /** The words of a text worth matching on (4+ letters or digits, any language). */
    _words(s) { return [...new Set(String(s || '').toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) || [])]; },
    _live(matters, now = Date.now()) {
        const since = now - this.WINDOW_DAYS * 86400000, today = this._iso(now);
        return (matters || []).filter(m => m && (m.state === 'open' || Date.parse(m.updatedAt || 0) >= since || (m.when && m.when.date >= today)));
    },
    /** How often each word appears across folders: a word in many folders ("reminder", "your") says nothing. */
    _rarity(live, textOf) {
        const bags = new Map(live.map(m => [m.id, new Set(this._words(textOf(m)))]));
        const df = new Map();
        for (const bag of bags.values()) for (const w of bag) df.set(w, (df.get(w) || 0) + 1);
        const max = Math.max(4, Math.floor(live.length * 0.25));
        return { bags, rare: w => (df.get(w) || 0) <= max };
    },
    _folderText(m) { return `${m.title || ''} ${m.vendor || ''} ${m.place || ''} ${(m.sources || []).map(s => `${s.from || ''} ${s.summary || ''}`).join(' ')}`; },
    _daysApart(a, b) { return a && b ? Math.abs(Date.parse(`${a}T12:00:00`) - Date.parse(`${b}T12:00:00`)) / 86400000 : Infinity; },
    /**
     * The second look (2026-10-05): before a NEW folder is made, the folders
     * the first search did not offer that share an uncommon word with it, or
     * the same kind around the same days. Found widely on purpose: a
     * duplicate nearly always means the right folder was never shown, and
     * the assistant decides, not this. Pure.
     */
    near(f, j, matters, shown = [], now = Date.now()) {
        const live = this._live(matters, now);
        const skip = new Set((shown || []).map(m => m.id));
        const { bags, rare } = this._rarity(live, m => this._folderText(m));
        const mine = this._words(`${(j && j.title) || ''} ${f.subject || ''} ${(!f.own && f.meta.name) || ''} ${f.summary || ''}`).filter(rare);
        const when = (j && j.when) || (f.dates || [])[0] || null;
        const score = m => {
            const shared = mine.filter(w => bags.get(m.id).has(w)).length;
            const day = this._daysApart(when, m.when && m.when.date) <= 2;
            const kind = !!(j && j.kind && j.kind !== 'other' && m.kind === j.kind);
            return shared || (day && kind) ? shared + (day ? 1 : 0) + (kind ? 1 : 0) : 0;
        };
        return live.filter(m => !skip.has(m.id)).map(m => ({ m, s: score(m) })).filter(x => x.s >= 2)
            .sort((a, b) => b.s - a.s || Date.parse(b.m.updatedAt || 0) - Date.parse(a.m.updatedAt || 0))
            .slice(0, this.NEAR_MAX).map(x => x.m);
    },
    // ── Judgment, checked ───────────────────────────────────────────────
    _nums(s) { return (String(s || '').match(/\d+(?:\.\d+)?/g) || []).map(n => String(Number(n))); },
    /** Keep what the assistant said only where it is checkable. Pure. `cands` are the folders it was shown, in order. */
    vet(raw, f, cands, now = Date.now(), events = [], tasks = [], instr = []) {
        if (!raw || typeof raw !== 'object') return null;
        // The answer's own second field outranks a muddled "about" (2026-10-12,
        // the Threads demo eval: a 35B model answered {"about": "none", "new":
        // true, …} for a trial that charges in two days and {"about": null,
        // "new": "M2"} for a bill, and both were dropped as nothing). What it
        // wrote in "new" is what it meant; and "none" beside "change": "new",
        // a real kind and a date ahead, an amount or a step is the prompt's
        // own "keep it quietly" case, never a sign-in code or an ad.
        let aboutRaw = raw.about;
        const noneish = aboutRaw == null || /^none$/i.test(String(aboutRaw).trim());
        if (noneish && raw.new != null && raw.new !== false) aboutRaw = raw.new === true ? 'new' : raw.new;
        // A real kind with a step, a date still ahead or an amount, and no folder named: the prompt's own
        // "keep it quietly" case, whatever "change" says (a renewal offer came back {"about": null,
        // "change": "changed", "when": "2026-11-02"} and was dropped, 2026-10-12). A settled one with an
        // amount is a payment that went through: money moved, kept quietly.
        else if (noneish && this.KINDS.includes(raw.kind) && raw.kind !== 'other') {
            const settled = ['done', 'cancelled'].includes(String(raw.change || '').toLowerCase());
            const step = raw.next && typeof raw.next === 'object' && String(raw.next.what || '').trim();
            const ahead = this._day(raw.when) && this._day(raw.when) >= this._iso(now);
            if (settled ? !!f.amount : !!(f.amount || step || ahead)) aboutRaw = 'new';
        }
        // A label however it was written ("M1", "M<1>", "[M1]"); a small model copies the brackets.
        let about = String(aboutRaw || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
        let target = null;
        if (/^m\d+$/.test(about)) {
            target = cands[Number(about.slice(1)) - 1] || null;
            // A folder it was not shown is refused. With NO folders shown, a
            // named one can only be a muddled "new": kept, not dropped.
            if (!target) { if (cands.length) return null; about = 'new'; }
        } else if (about !== 'new' && about !== 'none') {
            if (cands.length || !String(raw.title || '').trim()) return null;
            about = 'new';
        }
        // Nothing to keep track of is nothing to show (§17, 2026-10-07): a
        // "none" never tells. What is worth telling is worth a folder.
        if (about === 'none') return { about: 'none', tell: 'file' };
        const known = new Set([...this._nums(`${f.subject} ${f.body} ${f.summary} ${f.amount || ''} ${f.dates.join(' ')}`),
            ...(target ? this._nums(`${target.title} ${target.status} ${(target.sources || []).map(s => s.summary).join(' ')}`) : [])]);
        const clean = (s, max) => {
            const v = String(s || '').replace(/\s+/g, ' ').trim().slice(0, max);
            return v && this._nums(v).every(n => known.has(n)) ? v : '';
        };
        const lo = this._iso(now - 400 * 86400000), hi = this._iso(now + 730 * 86400000);
        const date = d => { const v = this._day(d); return v && v >= lo && v <= hi ? v : null; };
        const time = t => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || '').trim()); return m && +m[1] < 24 && +m[2] < 60 ? `${m[1].padStart(2, '0')}:${m[2]}` : null; };
        // M9: a generated summary is not evidence for work or a deadline.
        // Quotes must come from the actual message, never the Date header.
        const sourceText = `${f.subject || ''}\n${f.body || ''}`.replace(/\s+/g, ' ').trim();
        const quote = value => {
            const q = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
            return q.length >= 6 && q.length <= 600 && sourceText.includes(q) ? q : null;
        };
        let next = null;
        const n = raw.next;
        if (n && typeof n === 'object' && String(n.what || '').trim()) {
            let how = ['reply', 'link', 'none'].includes(n.how) ? n.how : 'none';
            let reply = String(n.reply || '').trim().slice(0, 300);
            // A short reply code must be one the message asks for.
            if (how === 'reply' && reply.length <= 12 && !new RegExp(`(^|[^a-z0-9])${reply.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`, 'i').test(`${f.subject} ${f.body}`)) reply = '';
            if (how === 'reply' && !reply && f.meta.imessage) how = 'none';
            const li = Number(n.link);
            const url = how === 'link' && Number.isInteger(li) && li >= 1 && li <= f.links.length ? f.links[li - 1] : null;
            if (how === 'link' && !url) how = 'none';
            const what = clean(n.what, 120);
            const actionQuote = quote(n.quote), byQuote = quote(n.by_quote), timeQuote = quote(n.time_quote);
            if (what) next = { what, label: String(n.label || '').replace(/\s+/g, ' ').trim().slice(0, 24) || null,
                by: byQuote ? date(n.by) : null, time: timeQuote ? time(n.time) : null,
                quote: actionQuote, byQuote, timeQuote,
                how, reply: reply || null, url, yours: n.yours === true, isTask: n.is_task === true };
        }
        // A task or an event the person made themselves opens no step: it is already theirs to do (MatterSources S2).
        if (f.own && f.source !== 'chat' && f.source !== 'slack') next = null;
        const ci = Number(raw.checkin_link);
        const label = v => String(v || '').trim().replace(/[^a-z0-9]/gi, '');
        const cal = /^C(\d+)$/i.exec(label(raw.calendar));
        const ev = cal ? events[Number(cal[1]) - 1] : null;
        const tk = /^T(\d+)$/i.exec(label(raw.task));
        const task = tk ? tasks[Number(tk[1]) - 1] : null;
        return {
            calendarEventId: ev ? ev.id : null,
            taskId: task ? task.id : null,
            about: target ? target.id : 'new',
            kind: this.KINDS.includes(raw.kind) ? raw.kind : 'other',
            title: clean(raw.title, 80), status: clean(raw.status, 80),
            // A new folder from a receipt is finished the day it is made (the prompt's own rule; a model that answered
            // "new" for a paid bill left six "open" water bills on the look's sheet, 2026-10-12).
            change: !target ? (f.type === 'receipt' && raw.change !== 'cancelled' ? 'done' : 'new') : this.CHANGES.includes(raw.change) && raw.change !== 'new' ? raw.change : 'same',
            when: date(raw.when), time: time(raw.time), next,
            checkinUrl: Number.isInteger(ci) && ci >= 1 && ci <= f.links.length ? f.links[ci - 1] : null,
            // What the person said or did themselves is never news to them.
            tell: f.own ? 'file' : this.TELL.includes(raw.tell) ? raw.tell : 'morning',
            // The standing instruction it falls under, only one it was shown (I2).
            instruction: instr.length && typeof Instructions !== 'undefined' ? Instructions.idOf(raw.instruction, instr) : null
        };
    },
    /** Fold a checked judgment into the store. Pure over `matters` (a map). Returns the folder, or null. */
    apply(matters, j, f, now = Date.now()) {
        if (!j || j.about === 'none') return null;
        const iso = new Date(now).toISOString();
        const kind = f.source || (f.meta.imessage ? 'imessage' : 'email');
        const isMessage = !!(this.SOURCES[kind] || {}).message;
        // `tell` rides the source entry (§17): the folder, not the message's
        // analysis, is what Now and the notices read.
        const src = { id: f.id, kind, at: f.at, from: f.meta.name || f.meta.address || '',
            address: f.meta.address || null, thread: f.meta.thread || null, summary: f.summary || f.subject, tell: this.TELL.includes(j.tell) ? j.tell : 'file' };
        let m = j.about !== 'new' ? matters[j.about] : null;
        // Where the folder stood before this was filed on it: what taking it back out restores (`pullOut`).
        const prev = m ? JSON.parse(JSON.stringify({ title: m.title, status: m.status, state: m.state, kind: m.kind, when: m.when || null, next: m.next || null })) : null;
        if (!m) {
            m = { id: `matter:${f.id}`, kind: j.kind, state: 'open', title: j.title || f.summary || f.subject, status: j.status || '',
                when: { date: j.when, time: j.time }, next: null, ids: [], sources: [], createdAt: iso, updatedAt: iso };
            matters[m.id] = m;
        }
        if (!m.sources.some(s => s.id === src.id)) m.sources.push({ ...src, filedAt: iso, ...(prev ? { prev } : {}) });
        if (f.source === 'slack') {
            m.privacySources = [...new Set([...this.privacySources(m), 'slack'])];
            const scope = { workspaceId: f.slack.workspaceId, userId: f.slack.userId, channelId: f.slack.channelId };
            m.slackScopes = [...new Map([...(m.slackScopes || []), scope].map(s => [JSON.stringify(s), s])).values()];
            const saved = m.sources.find(s => s.id === src.id);
            saved.slack = structuredClone(f.slack);
        }
        m.sources.sort((a, b) => Date.parse(a.at || 0) - Date.parse(b.at || 0));
        m.ids = [...new Set([...(m.ids || []), ...f.ids])].slice(0, 20);
        if (j.kind !== 'other' || !m.kind) m.kind = j.kind;
        if (j.title) m.title = j.title;
        if (j.status) m.status = j.status;
        // The amount the message itself stated (the money sheet reads it).
        if (f.amount) m.amount = f.amount;
        if (j.when && !m.calendarEventId) m.when = { date: j.when, time: j.time || (j.when === (m.when && m.when.date) ? m.when.time : null) };
        if (j.checkinUrl) m.checkinUrl = j.checkinUrl;
        if (j.calendarEventId) m.calendarEventId = j.calendarEventId;
        const r = f.reservation;
        if (r) Object.assign(m, { resKind: r.kind || m.resKind || null, vendor: r.vendor || m.vendor || null,
            code: r.confirmationCode || m.code || null, place: r.place || r.to || m.place || null,
            end: this._day(r.returnEnd || r.returnStart || r.end) || m.end || null });
        if (j.taskId) this.relateTask(m, j.taskId, now);
        if (j.change === 'done' || j.change === 'cancelled') {
            m.state = j.change === 'cancelled' ? 'cancelled' : 'done';
            if (m.next && m.next.state === 'open') Object.assign(m.next, { state: 'done', doneBy: 'message', doneAt: iso });
        } else {
            if (m.state !== 'open' && j.change !== 'same') m.state = 'open';
            if (j.next) {
                const keep = m.next && m.next.state === 'open' ? m.next : null;
                // A step the person named in their own words keeps the message it came from (the one to open).
                m.next = { ...j.next, state: 'open', askedAt: keep ? keep.askedAt : (f.at || iso), taskId: keep ? keep.taskId || null : null,
                    to: f.meta.imessage ? f.meta.address : null, messageId: isMessage ? f.id : (m.next && m.next.messageId) || null };
                // The person already has a task for this: the step IS that
                // task, so none is made for it.
                if (!m.next.taskId && m.next.yours && m.next.isTask && j.taskId) m.next.taskId = j.taskId;
                delete m.next.isTask;
            }
        }
        m.updatedAt = iso;
        return m;
    },
    /** A task that is about this folder (the person's own, or the step's). Pure. */
    relateTask(m, taskId, now = Date.now()) {
        if (!m || !taskId) return;
        m.tasks = Array.isArray(m.tasks) ? m.tasks : [];
        if (!m.tasks.includes(taskId)) { m.tasks.push(taskId); m.tasks = m.tasks.slice(-10); }
    },
    /** What happened to the folder outside its messages (the calendar, tasks). Pure; newest last, 20 kept. */
    note(m, from, text, now = Date.now(), id = null) {
        if (!m || !text) return;
        m.log = Array.isArray(m.log) ? m.log : [];
        const last = m.log[m.log.length - 1];
        if (last && last.from === from && last.text === text) return;
        m.log.push({ at: new Date(now).toISOString(), from, text: String(text).slice(0, 160), ...(id ? { id } : {}) });
        if (m.log.length > 20) m.log = m.log.slice(-20);
    },
    // ── Words the surfaces show ─────────────────────────────────────────
    titleOf(m) { return (m && m.title) || 'Something to look at'; },
    /** The open next step, shaped for the surfaces ({id, kind, label}). */
    openStep(m) {
        const n = m && m.next;
        return n && n.state === 'open' && !n.evidenceInvalidated ? { ...n, id: 'next', kind: n.how } : null;
    },
});
if (typeof module !== 'undefined' && module.exports) module.exports = MatterRecords;
