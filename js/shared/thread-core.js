'use strict';
// Shared thread presentation rules (SENDERS S1-S8, MOBILE_THREADS MT5-MT6).
// Records in, display data out. No DOM, storage, network, model or tool calls.
// Desktop ThreadsPage composes this object; Swift executes this exact source
// in JavaScriptCore. Native rendering must not reimplement these decisions.
// Runtime failures propagate to the host; they are never an empty timeline.
const ThreadCore = (() => {
    const Calendar = typeof module !== 'undefined' && module.exports ? require('./commitment-calendar') : CommitmentCalendar;
    return Object.freeze({
        _t(v) { const t = Date.parse(v || 0); return isNaN(t) ? 0 : t; },
        _sentence(s) { s = String(s || '').trim(); return !s ? '' : /[.!?)"”]$/.test(s) ? s : s + '.'; },
        _plain(md) { return String(md || '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/```[\s\S]*?```/g, '').replace(/[*_`#>]+/g, '').replace(/\s+/g, ' ').trim(); },
        /**
         * The thread for one folder, oldest first. Each item:
         * { at, side: 'them' | 'me', text, kind: 'message' | 'log' | 'chat' | 'now', ... }.
         * `conv` is the folder's chat (or null); `card` its open Now card (or null).
         */
        timeline(m, conv = null, card = null, now = Date.now()) {
            if (!m) return [];
            const out = [];
            const sources = (m.sources || []).filter(s => !s.kind || ['email', 'imessage', 'slack'].includes(s.kind));
            sources.forEach((s, i) => {
                const how = s.kind === 'imessage' ? 'texted' : s.kind === 'slack' ? 'wrote on Slack' : 'emailed';
                const who = s.from || 'Someone';
                const what = this._sentence(s.summary);
                const first = i === 0;
                out.push({ at: this._t(s.at || s.filedAt), side: 'them', kind: 'message', id: s.id, via: s.kind || 'email', from: who,
                    text: first ? `${who} ${how}. ${what}`.trim() : `${who} ${how} again. ${what}`.trim() });
            });
            for (const l of m.log || []) out.push({ at: this._t(l.at), side: 'them', kind: 'log', text: this._sentence(l.text) });
            if (!sources.length && !(m.log || []).length && m.createdAt) {
                out.push({ at: this._t(m.createdAt), side: 'them', kind: 'log', text: this._sentence(m.title) });
            }
            // A conversation's messages keep their order: a reply is never drawn above what it answers.
            let lastMsgAt = 0;
            for (const msg of (conv && conv.messages) || []) {
                if (!msg || !['user', 'assistant'].includes(msg.role)) continue;
                if (msg.metadata && msg.metadata.fromCard) continue;   // the code-written opener: the thread already says it
                const text = typeof msg.content === 'string' ? msg.content : '';
                if (!text.trim()) continue;
                out.push({ at: (lastMsgAt = Math.max(lastMsgAt, this._t(msg.timestamp) || this._t(conv.updatedAt))), side: msg.role === 'user' ? 'me' : 'them', kind: 'chat', text, md: msg.role === 'assistant', meta: msg.metadata || null });
            }
            // Where it stands: the status when the folder last changed (unless a
            // bubble already says it), or how it ended.
            const updated = this._t(m.updatedAt);
            if (!card && m.state === 'open' && m.status && !out.some(x => x.side === 'them' && x.text.toLowerCase().includes(String(m.status).toLowerCase()))) {
                out.push({ at: updated, side: 'them', kind: 'status', text: this._sentence(m.status) });
            } else if (!card && m.state && m.state !== 'open') {
                const word = { done: 'All done with this one.', past: 'This one is behind you now.', cancelled: 'This was cancelled.', ignored: 'You set this aside.' }[m.state];
                if (word) out.push({ at: updated, side: 'them', kind: 'status', text: word });
            }
            // Where it stands is not an event: it rides at the end, outside the
            // timeline (drawn under the header, never as a bubble; 2026-10-10,
            // reported: "the timeline is being shown a standing message").
            const status = out.filter(x => x.kind === 'status');
            out.splice(0, out.length, ...out.filter(x => x.kind !== 'status').sort((a, b) => a.at - b.at), ...status);
            // The open Now card is the newest thing nenva is asking: last.
            // A raise made by a look carries its own time (lookAt), so a new one marks the thread unread (M6b).
            if (card) out.push({ at: Math.max(out.length ? out[out.length - 1].at : 0, updated, card.lookAt || 0), side: 'them', kind: 'now', text: this._sentence(card.body || card.title), card });
            return out;
        },
        _dayWords(iso) { return iso ? new Date(`${iso}T12:00:00`).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }) : ''; },
        _clock(hm) {
            const m = /^(\d{1,2}):(\d{2})$/.exec(String(hm || ''));
            return m ? new Date(2000, 0, 1, +m[1], +m[2]).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
        },
        REPEAT_WORDS: { daily: 'Every day', weekdays: 'Every weekday', weekly: 'Every week', monthly: 'Every month', yearly: 'Every year', custom: 'On set days' },
        /** When a commitment is, in words: "Every day at 9:00 AM", "Fri, Oct 14 at 9:00 AM", "". */
        commitmentWhen(c) {
            const w = (c && c.when) || {};
            const at = w.time ? ` at ${this._clock(w.time)}` : '';
            if (c && c.repeat && c.repeat.rule && c.repeat.rule !== 'none') {
                const days = (c.repeat.days || []).map(d => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d]).filter(Boolean);
                return `${days.length && ['weekly', 'custom'].includes(c.repeat.rule) ? `Every ${days.join(', ')}` : this.REPEAT_WORDS[c.repeat.rule] || 'Repeats'}${at}`;
            }
            return w.date ? `${this._dayWords(w.date)}${at}` : '';
        },
        /** What one ledger line did, in words; '' when it says nothing the thread shows. */
        ledgerWords(e) {
            const after = e.after || {}, before = e.before || {};
            const day = o => Object.keys(o || {})[0];
            if (e.op === 'done' || e.op === 'dropped') {
                const d = day(after.history);
                return `${e.op === 'done' ? 'Marked done' : 'Let go'}${d ? ` for ${this._dayWords(d)}` : ''}.`;
            }
            if (e.op === 'report') {
                const d = day(after.history) || day(after.log);
                const how = after.history && after.history[d];
                if (how && !(before.history && before.history[d] === how)) return `${how === 'done' ? 'Marked done' : 'Let go'} for ${this._dayWords(d)}.`;
                return d ? `Noted how ${this._dayWords(d)} went.` : '';
            }
            if (e.op === 'reopen') return 'Opened again.';
            if (e.op === 'move-day') {
                const d = day(after.moved); const v = d && after.moved[d];
                return d ? (v && v.time ? `${this._dayWords(d)} moved to ${this._clock(v.time)}, that day only.` : `${this._dayWords(d)} is back at the usual time.`) : '';
            }
            if (e.op === 'change') {
                const out = [];
                if ('when' in after) out.push(after.when && after.when.date ? `Moved to ${this._dayWords(after.when.date)}${after.when.time ? ` at ${this._clock(after.when.time)}` : ''}.` : after.when && after.when.time ? `Now at ${this._clock(after.when.time)}.` : 'Date cleared.');
                if ('title' in after) out.push(`Renamed “${after.title}”.`);
                if ('by' in after) out.push(after.by ? `Due by ${this._dayWords(after.by)}.` : 'No deadline now.');
                if ('repeat' in after) out.push(after.repeat && after.repeat.rule && after.repeat.rule !== 'none' ? `${this.REPEAT_WORDS[after.repeat.rule] || 'Repeats'} now.` : 'Stopped repeating.');
                if ('waitingOn' in after) out.push(after.waitingOn && after.waitingOn.who ? `Waiting on ${after.waitingOn.who}.` : 'Not waiting on anyone now.');
                if (!out.length && Object.keys(after).length) out.push('Details updated.');
                return out.join(' ');
            }
            return '';
        },
        /** The thread for one commitment, oldest first (the same item shape as `timeline`). Pure over its arguments. */
        commitmentTimeline(c, conv = null, card = null, ledger = [], now = Date.now(), today = null) {
            if (!c) return [];
            today = today || this._isoDay(now);
            const out = [];
            const origin = c.origin || {};
            const when = this.commitmentWhen(c);
            const from = origin.kind === 'chat' ? 'Added from a chat' : origin.kind === 'matter' || origin.kind === 'email' ? `Added from ${origin.title ? `“${origin.title}”` : 'your mail'}` : 'You added this';
            out.push({ at: this._t(c.createdAt), side: 'them', kind: 'log', text: `${from}.` });
            for (const e of ledger) {
                if (e.op === 'create') continue;
                const text = this.ledgerWords(e);
                if (text) out.push({ at: this._t(e.at), side: 'them', kind: 'log', text });
            }
            // A conversation's messages keep their order: a reply is never drawn above what it answers.
            let lastMsgAt = 0;
            for (const msg of (conv && conv.messages) || []) {
                if (!msg || !['user', 'assistant'].includes(msg.role) || (msg.metadata && msg.metadata.fromCard)) continue;
                const text = typeof msg.content === 'string' ? msg.content : '';
                if (!text.trim()) continue;
                out.push({ at: (lastMsgAt = Math.max(lastMsgAt, this._t(msg.timestamp) || this._t(conv.updatedAt))), side: msg.role === 'user' ? 'me' : 'them', kind: 'chat', text, md: msg.role === 'assistant', meta: msg.metadata || null });
            }
            // nenva's own read of it (the line Now would show), when no card says it.
            if (!card && c.state === 'open' && c.read && c.read.why) out.push({ at: this._t(c.read.at), side: 'them', kind: 'read', text: this._sentence(c.read.why) });
            out.sort((a, b) => a.at - b.at);
            const last = out.length ? out[out.length - 1].at : 0;
            if (card) {
                out.push({ at: Math.max(last, this._t(c.updatedAt), card.lookAt || 0), side: 'them', kind: 'now', text: this._sentence(card.body || card.title), card });
                return out;
            }
            // Where it stands, by arithmetic.
            let stand = '';
            const repeats = !!(c.repeat && c.repeat.rule && c.repeat.rule !== 'none');
            if (c.state === 'done') stand = 'All done with this one.';
            else if (c.state === 'dropped') stand = 'You let this one go.';
            else if (repeats) {
                let next = null;
                try { next = Calendar.nextOn(c, today); } catch { next = null; }
                const t = next ? Calendar.timeOn(c, next) : null;
                const doneToday = Calendar.isDone(c, today);
                stand = next ? `${next === today ? (doneToday ? 'Done for today.' : 'Today') : `Next: ${this._dayWords(next)}`}${next === today && doneToday ? '' : `${t && t.time ? ` at ${this._clock(t.time)}` : ''}.`}` : `${when}.`;
            } else if (c.when && c.when.date) {
                stand = c.when.date < today ? `This was due ${this._dayWords(c.when.date)}.` : c.when.date === today ? `Today${c.when.time ? ` at ${this._clock(c.when.time)}` : ''}.` : `Coming up ${when}.`;
            } else if (c.by) stand = `Due by ${this._dayWords(c.by)}.`;
            if (stand) out.push({ at: Math.max(last, this._t(c.updatedAt)), side: 'them', kind: 'status', text: stand });
            return out;
        },
        _isoDay(t) { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; },
        /** When the newest event happened (a background save of the record is not one). */
        lastEventAt(items) { const ev = this.events(items); return ev.length ? ev[ev.length - 1].at : 0; },
        /** The timeline proper: everything but the status line. */
        events(items) { return items.filter(x => x.kind !== 'status'); },
        statusOf(items) { const x = items.find(i => i.kind === 'status'); return x ? x.text : ''; },
        lastAt(items, m) { const ev = this.events(items); return Math.max(ev.length ? ev[ev.length - 1].at : 0, this._t(m && m.updatedAt)); },
        preview(items) {
            const ev = this.events(items);
            const x = ev[ev.length - 1];
            if (!x) return this.statusOf(items);
            if (!x) return '';
            const text = x.md ? this._plain(x.text) : x.text;
            return (x.side === 'me' ? 'You: ' : '') + text;
        },
        /** iMessage's list times: a clock today, Yesterday, a weekday this week, else a date. */
        timeLabel(t, now = Date.now()) {
            if (!t) return '';
            const d = new Date(t), n = new Date(now);
            const day = x => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
            const diff = Math.round((day(n) - day(d)) / 86400000);
            if (diff <= 0) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
            if (diff === 1) return 'Yesterday';
            if (diff < 7) return d.toLocaleDateString([], { weekday: 'long' });
            return d.toLocaleDateString([], { month: 'numeric', day: 'numeric', year: '2-digit' });
        },
        /** The centred stamp between bubbles more than an hour apart. */
        stampLabel(t, now = Date.now()) {
            const d = new Date(t);
            const head = this.timeLabel(t, now);
            const clock = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
            return head === clock ? `Today ${clock}` : `${head} ${clock}`;
        },
        /**
         * Cards with no thread of their own land in nenva's (M6b, M7): money as
         * a whole, a plan, a memory, a follow-up with no folder, a trip, a
         * routine's news, a meeting no folder is, an introduction, and every
         * approval (2026-10-11: Now shows no cards; a chat's own approval also
         * rides its thread's ribbon). Pure.
         */
        homeless(cards, thingOf, eventHasFolder = () => false, routineHeld = () => false, jobHeld = () => false) {
            return (cards || []).filter(c => {
                if (!c) return false;
                if (c.kind === 'approval') return true;
                const t = String(thingOf(c) || '');
                if (/^(matter|task|sender):/.test(t)) return false;
                if (/^event:/.test(t) && eventHasFolder(t.slice(6))) return false;
                // A routine attached to a thing: its news is in that thread (M8).
                const rid = c.routineId || c.routineOf || (/^routine:/.test(t) ? t.slice(8) : null);
                if (rid && routineHeld(rid)) return false;
                // A job started in a thing's chat reports in that thread already.
                if (c.job && jobHeld(c.job)) return false;
                return true;
            });
        },
        _unread(items, at, seen, key) {
            const ev = this.events(items);
            const last = ev[ev.length - 1];
            return !!seen.__init && at > (seen[key] || 0) && !!last && last.side === 'them' && last.kind !== 'log';
        },
        _keeps(c) { return !!(c && c.title && !(c.origin && c.origin.kind === 'plan') && !(c.privacySources || []).includes('slack')); },
        /**
         * A goal's thread over its family's rows (pure over them): every
         * member's events tagged with the step they are about (the goal's own
         * untagged), its card and its chat; `members` are the steps.
         */
        goalRow(lead, stepRows, seen = {}) {
            if (!stepRows.length) return lead;
            const items = this.senderTimeline(null, [lead, ...stepRows], null, null)
                .map(i => i.member === lead.key ? { ...i, about: '' } : i);
            const at = Math.max(lead.at, ...stepRows.map(r => r.at));
            const seenAt = seen[lead.key] || Math.max(0, ...stepRows.map(r => seen[r.key] || 0));
            const card = (items.filter(x => x.kind === 'now').pop() || {}).card || lead.card;
            return { ...lead, items, at, card, settled: lead.settled && stepRows.every(r => r.settled),
                members: stepRows.map(r => r.key), memberRows: [lead, ...stepRows], unread: this._unread(items, at, { ...seen, [lead.key]: seenAt }, lead.key) };
        },
        /**
         * Rows holding a pinned thing first, in pin order: the thing's own row,
         * or the sender's that holds it; a pinned thing with no listed row gets
         * one (`make`). Pure over its arguments.
         */
        pinnedFirst(rows, keys, make = () => null) {
            const pinned = [], used = new Set();
            for (const k of keys) {
                let r = rows.find(x => x.key === k || (x.members || []).includes(k));
                if (!r) { r = make(k); if (!r) continue; }
                if (used.has(r.key)) continue;
                used.add(r.key);
                pinned.push({ ...r, pin: true });
            }
            return { pinned, rest: rows.filter(r => !used.has(r.key)) };
        },
        /**
         * One sender's thread from its members' own rows (pure over them): every
         * member's events, each tagged with the member it is about; the sender's
         * own conversation; the open cards last. The intro (S3) is first while
         * the sender is unconfirmed.
         */
        senderTimeline(s, memberRows = [], conv = null, own = null) {
            const events = [], nows = [];
            const many = memberRows.length > 1;
            for (const r of memberRows) {
                for (const x of r.items) {
                    if (x.kind === 'status') continue;
                    const tagged = { ...x, member: r.key, about: many ? r.title : '' };
                    (x.kind === 'now' ? nows : events).push(tagged);
                }
            }
            // A conversation's messages keep their order: a reply is never drawn above what it answers.
            let lastMsgAt = 0;
            for (const msg of (conv && conv.messages) || []) {
                if (!msg || !['user', 'assistant'].includes(msg.role) || (msg.metadata && msg.metadata.fromCard)) continue;
                const text = typeof msg.content === 'string' ? msg.content : '';
                if (!text.trim()) continue;
                const ho = msg.metadata && msg.metadata.handoff;
                events.push({ at: (lastMsgAt = Math.max(lastMsgAt, this._t(msg.timestamp) || this._t(conv.updatedAt))), side: msg.role === 'user' ? 'me' : 'them', kind: 'chat', text, md: msg.role === 'assistant', meta: msg.metadata || null,
                    ...(ho ? { about: 'From your chat with nenva', handoff: ho.from || '' } : {}) });
            }
            events.sort((a, b) => a.at - b.at);
            const out = [];
            if (s && !s.confirmed && !s.builtIn) {
                const first = events.length ? events[0].at : 0, made = this._t(s.createdAt);
                out.push({ at: first && made ? Math.min(first, made) : (first || made), side: 'them', kind: 'intro', sender: s.id,
                    text: `I started keeping track of ${s.name} for you.${s.allGood ? ` All good means: ${this._sentence(s.allGood)}` : ''}` });
            }
            // The sender's own look raised something (M6): its card comes last, at the time of the look.
            if (own) nows.push({ at: Math.max(own.lookAt || 0, events.length ? events[events.length - 1].at : 0), side: 'them', kind: 'now', text: own.body ? `${this._sentence(own.title)} ${this._sentence(own.body)}` : this._sentence(own.title), card: own });
            out.push(...events, ...nows.sort((a, b) => a.at - b.at));
            // Where it stands: the open member that changed last says it.
            const open = memberRows.filter(r => !r.settled);
            const lead = (open.length ? open : memberRows).slice().sort((a, b) => b.at - a.at)[0];
            const st = lead && this.statusOf(lead.items);
            if (st) out.push({ at: lead.at, side: 'them', kind: 'status', text: many ? `${lead.title}: ${st}` : st });
            return out;
        },
        /**
         * A sender's info page (docs/SENDERS.md M3), from its members' rows. Pure
         * over its arguments; `nextOf(c, today)` is a commitment's next day.
         *   open / settled  the items, open first by what changed last
         *   upcoming        dated things still ahead, soonest first (five)
         *   facts           what the mail said that a person looks up: amounts,
         *                   confirmation or policy numbers, the place, each with
         *                   the item it came from (eight, no repeats)
         * Sections with nothing to say are empty; the page draws none of them.
         */
        INFO_UPCOMING: 5,
        INFO_FACTS: 8,
        senderInfo(memberRows = [], today = '', nextOf = null) {
            const byAt = (a, b) => b.at - a.at;
            const item = r => ({ key: r.key, title: r.title, facts: r.facts || '', status: this.statusOf(r.items), type: r.type });
            const open = memberRows.filter(r => !r.settled).sort(byAt).map(item);
            const settled = memberRows.filter(r => r.settled).sort(byAt).map(item);
            const upcoming = [];
            for (const r of memberRows) {
                if (r.settled || !r.rec) continue;
                if (r.type === 'matter') {
                    const w = r.rec.when || {};
                    if (w.date && w.date >= today) upcoming.push({ key: r.key, title: r.title, date: w.date, time: w.time || null });
                } else {
                    const c = r.rec;
                    const next = nextOf ? nextOf(c, today) : (c.when && c.when.date) || null;
                    const date = next && next >= today ? next : c.by && c.by >= today ? c.by : null;
                    if (date) upcoming.push({ key: r.key, title: r.title, date, time: (c.when && c.when.time) || null, by: date === c.by && date !== next });
                }
            }
            upcoming.sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')));
            const facts = [], seen = new Set();
            const add = (label, value, r) => {
                const v = String(value == null ? '' : value).trim();
                if (!v || v === 'null' || seen.has(`${label}|${v}`)) return;
                seen.add(`${label}|${v}`);
                facts.push({ label, value: v, from: r.title, key: r.key });
            };
            for (const r of memberRows.slice().sort(byAt)) {
                if (r.type !== 'matter' || !r.rec) continue;
                const m = r.rec;
                if (m.amount) add('Amount', m.amount, r);
                if (m.code) add(m.resKind ? 'Confirmation' : 'Number', `#${m.code}`, r);
                if (m.place) add('Place', m.place, r);
                else if (m.vendor) add('From', m.vendor, r);
                if (m.calendar && m.calendar.location && m.calendar.location !== m.place) add('Where', m.calendar.location, r);
            }
            return { open, settled, upcoming: upcoming.slice(0, this.INFO_UPCOMING), facts: facts.slice(0, this.INFO_FACTS) };
        },
        _letter(name) { const m = /[\p{L}\p{N}]/u.exec(String(name || '')); return m ? m[0].toUpperCase() : '·'; },
        WORK_META: 'Bills, deadlines and bookings that need you will each get a thread here.',
        /**
         * What nenva's thread says about reading (pure). `email` is
         * SimpleExperience.emailHome() plus its `line`; `connectedAt` the newest
         * mail connection (ms); `lastSync` the mailbox's last sync (ms);
         * `calendar` the calendar's status words. { busy, text } while reading,
         * { done: connectedAt } once the first read after a connect is over, or null.
         */
        workState({ email = null, connectedAt = 0, lastSync = 0, calendar = '' } = {}) {
            if (email && !email.blocked) {
                if (email.reading) return { busy: true, text: email.line || 'Reading your email…' };
                // Connected, and the first sync has not even started: still getting it.
                if (email.caughtUp && connectedAt && !(lastSync && lastSync >= connectedAt - 60000)) return { busy: true, text: 'Getting your recent email…' };
            }
            if (calendar) return { busy: true, text: calendar };
            if (email && email.caughtUp && connectedAt) return { busy: false, done: connectedAt };
            return null;
        },
        /** nenva's words when the first read is over. Pure. */
        readDoneText(n) {
            return n > 0
                ? `I’ve read your recent email. I’m keeping track of ${n === 1 ? 'one thing' : `${n} things`} from it, each in its own thread in this list.`
                : 'I’ve read your recent email. Nothing in it needs you right now; when something does, it gets its own thread here.';
        },
        WELCOME: 'Hi, I’m nenva. I keep the things in your life from slipping: bills, appointments, renewals, replies. Each thing I look after gets its own thread here. I’ll show you what else I can help with a little at a time. Ask me anything.',
        /**
         * Unread threads first, then by time (2026-10-10, by request). The
         * thread just opened keeps its place among the unread until another is
         * picked (`sticky`), so reading it does not make it jump away. Pure.
         */
        order(rows, sticky = null) {
            const first = r => r.unread || r.key === sticky;
            return rows.slice().sort((a, b) => (first(b) - first(a)) || (b.at - a.at));
        },
    });
})();

if (typeof module !== 'undefined' && module.exports) module.exports = ThreadCore;
