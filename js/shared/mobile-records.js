'use strict';
// Native record adapter: local blobs in, shared timeline values out. It never
// writes records, starts work, or treats delivery as a request to execute.
const MobileRecords = Object.freeze({
    panelDefinition: { type: 'function', function: {
        name: 'get_thread_panel',
        description: 'Read the exact charts and supporting records shown by the chart button in a local thread: progress, recorded days, upcoming items and bill amounts. Every figure comes from saved records. Opening or reading a panel never starts work.',
        parameters: { type: 'object', properties: { id: { type: 'string', description: 'The sender, matter or commitment thread id. A bare commitment id is also accepted.' } }, required: ['id'] }
    } },
    panel(blobs, id, today = CommitmentCalendar.today()) {
        if (typeof id !== 'string' || !id.trim() || id.length > 220) return { error: 'Choose an existing thread.' };
        const raw = id.trim(), key = /^(sender|matter|task):/.test(raw) || raw === 'nenva' ? raw : `task:${raw}`;
        const snapshot = this.snapshot(blobs, today, Date.now(), { panelKeys: [key] });
        const home = snapshot.homes[key] || key;
        const row = [...snapshot.threads, ...snapshot.otherThreads].find(r => r.key === home);
        if (!row || row.key === 'nenva') return { error: 'No panel for that thread.' };
        return { thread: row.title, threadId: row.key, blocks: row.panel,
            ...(row.arrangedBy ? { arrangedBy: row.arrangedBy } : {}),
            ...(row.panel.length ? {} : { note: 'No figures, dated items or amounts are saved for this thread yet.' }) };
    },
    snapshot(blobs, today, now = Date.now(), options = {}) {
        const senders = blobs.senders || {};
        const data = { senders: senders.senders || {}, place: senders.place || {}, aliases: senders.aliases || {} };
        const matters = Object.values((blobs.matters || {}).matters || {}).filter(m => !(m.privacySources || []).includes('slack'));
        const seen = senders.threadSeen || {};
        const hidden = senders.threadHidden || {};
        const commitments = ((blobs.commitments || {}).items || []).filter(c => !(c.privacySources || []).includes('slack') && !(c.origin && c.origin.kind === 'plan'));
        const C = Object.assign({}, CommitmentCalendar, CommitmentRecords, {
            _load: () => ({ items: Object.fromEntries(commitments.map(c => [c.id, c])) }), _measureSources: []
        });
        const conversations = ((blobs.conversations || {}).conversations || []).filter(c => !c.private);
        const conv = key => conversations.filter(c => c.todayKey === key).sort((a, b) => ThreadCore._t(b.updatedAt) - ThreadCore._t(a.updatedAt))[0] || null;
        const owner = key => SenderMembership.senderOfIn(data, key, {
            matterOf: id => matters.find(m => m.id === id),
            folderOfTask: id => matters.find(m => (m.tasks || []).includes(id) || (m.next && m.next.taskId === id)),
            commitment: id => commitments.find(c => c.id === id)
        });
        const members = [
            ...matters.map(m => ({ key: m.id, title: m.title || 'Untitled', type: 'matter', rec: m,
                items: ThreadCore.timeline(m, conv(m.id), null, now), settled: m.state !== 'open' })),
            ...commitments.map(c => ({ key: `task:${c.id}`, title: c.title || 'Untitled', type: 'commitment', rec: c,
                items: ThreadCore.commitmentTimeline(c, conv(`task:${c.id}`), null, (blobs.commitments || {}).ledger || [], now, today), settled: c.state !== 'open' }))
        ].map(r => ({ ...r, at: ThreadCore.lastEventAt(r.items), facts: r.type === 'commitment' ? ThreadCore.commitmentWhen(r.rec) : '' }));
        const info = children => {
            const value = ThreadCore.senderInfo(children, today, (c, d) => CommitmentCalendar.nextOn(c, d));
            for (const section of ['open', 'settled']) value[section] = value[section].map(row => {
                const c = row.type === 'commitment' ? commitments.find(c => `task:${c.id}` === row.key) : null;
                return c ? { ...row, done: CommitmentCalendar.isDone(c, today) } : row;
            });
            return value;
        };
        const rows = Object.values(data.senders).map(s => {
            const children = members.filter(r => owner(r.key) === s.id);
            const items = ThreadCore.senderTimeline(s, children, conv(s.id));
            return { key: s.id, type: 'sender', title: s.name, facts: s.allGood || '', items, archived: s.state === 'archived', memberRows: children,
                info: info(children),
                at: ThreadCore.lastEventAt(items), unread: ThreadCore._unread(items, ThreadCore.lastEventAt(items), seen, s.id) };
        });
        const reminders = members.filter(r => r.type === 'commitment' && !owner(r.key) && SenderMembership.isToDo(r.rec, commitments));
        const reminderKeys = new Set(reminders.map(r => r.key));
        for (const r of members) if (!owner(r.key) && !reminderKeys.has(r.key)) {
            const root = r.type === 'commitment' ? C.rootOf(r.rec, commitments) : null;
            const lead = root && members.find(m => m.key === `task:${root.id}`);
            if (lead && lead !== r) continue;
            const children = root ? members.filter(m => m.type === 'commitment' && C.rootOf(m.rec, commitments)?.id === root.id && !owner(m.key)) : [r];
            const row = root ? ThreadCore.goalRow(r, children.filter(m => m !== r), seen) : r;
            rows.push({ ...row, memberRows: children, info: info(children), unread: ThreadCore._unread(row.items, row.at, seen, r.key) });
        }
        const reminder = SenderMembership.reminders();
        const reminderItems = ThreadCore.senderTimeline(reminder, reminders, conv(reminder.id));
        const reminderRow = { key: reminder.id, type: 'sender', title: reminder.name, facts: reminder.allGood, items: reminderItems,
            memberRows: reminders, info: info(reminders), at: ThreadCore.lastEventAt(reminderItems) };
        // Existing untied conversations remain reachable inside nenva's thread.
        const general = conversations.filter(c => !c.todayKey || c.todayKey === 'nenva');
        // Source-review chats remain in history, but never become the trusted
        // general composer just because their last save is newer.
        const latest = general.filter(c => !c.untrusted).sort((a, b) => ThreadCore._t(b.updatedAt) - ThreadCore._t(a.updatedAt))[0] || null;
        const nenvaItems = ThreadCore.senderTimeline(null, [], latest);
        const nenva = { key: 'nenva', type: 'nenva', title: 'nenva', facts: '', items: nenvaItems, conversations: general,
            conversationId: latest && latest.id, at: ThreadCore.lastEventAt(nenvaItems), preview: ThreadCore.preview(nenvaItems) || 'Ask me anything.' };
        const due = commitments.filter(c => c.state === 'open' && !CommitmentCalendar.isDone(c, today) &&
            (CommitmentCalendar.repeats(c) ? CommitmentCalendar.occursOn(c, today) : c.when && c.when.date && c.when.date <= today))
            .map(c => ({ key: owner(`task:${c.id}`) || (reminderKeys.has(`task:${c.id}`) ? reminder.id : `task:${c.id}`), title: c.title, when: ThreadCore.commitmentWhen(c) }));
        const homes = Object.fromEntries(members.map(r => {
            const root = r.type === 'commitment' ? C.rootOf(r.rec, commitments) : null;
            return [r.key, owner(r.key) || (reminderKeys.has(r.key) ? reminder.id : root ? `task:${root.id}` : r.key)];
        }));
        for (const alias of Object.keys(data.aliases)) {
            const target = SenderMembership.resolve(data, alias);
            if (data.senders[target]) homes[alias] = target;
        }
        const schedule = this.schedule(commitments, matters, today, key => homes[key] || key);
        const requested = Array.isArray(options.panelKeys) ? new Set(options.panelKeys.map(key => homes[key] || key)) : null;
        const allThreads = [nenva, reminderRow, ...ThreadCore.order(rows)].map(r => {
            const arrangement = blobs['thread-panels']?.byKey?.[r.key];
            const panel = !requested || requested.has(r.key) ? ThreadPanelCore.blocksFor(r, { today, Commitments: C, AnswerBlocks: AnswerBlockData, strict: true,
                upcoming: children => info(children).upcoming, arrangement }).map(p => ({ ...p, block: this.displayBlock(p.block) })) : [];
            const { memberRows, ...row } = r;
            return { ...row, panel, ...(arrangement ? { arrangedBy: arrangement.by === 'you' ? 'the person' : 'nenva' } : {}),
                preview: r.preview || ThreadCore.preview(r.items), timeLabel: ThreadCore.timeLabel(r.at, now) };
        });
        const listed = r => !r.archived && !hidden[r.key];
        return { threads: allThreads.filter(listed), otherThreads: allThreads.filter(r => !listed(r)), homes, due, schedule };
    },

    // Formatting is code's too. The native UI draws these exact strings;
    // get_thread_panel returns the same raw values and display values.
    displayBlock(block) {
        const out = { ...block };
        if (block.kind === 'stats' || block.kind === 'bar') out.items = block.items.map(i => ({ ...i,
            display: AnswerBlockData.formatValue(i.value, i.format, i.signed) }));
        if (block.kind === 'line') out.points = block.points.map(p => ({ ...p,
            dateLabel: AnswerBlockData.formatValue(p.x, 'date'), display: AnswerBlockData.formatValue(p.y, block.format, false) }));
        if (block.kind === 'days') {
            out.days = block.days.map(d => ({ ...d,
                dateLabel: AnswerBlockData.formatValue(d.date, 'date'), stateLabel: AnswerBlockData.DAY_WORDS[d.state] }));
            out.summary = AnswerBlockData.daySummary(block.days);
        }
        if (block.kind === 'table') out.rows = AnswerBlockData.sortRows(block.rows, block.sort, block.columns).map(row => ({ ...row,
            cells: block.columns.map(c => ({ key: c.key, label: c.label, value: row[c.key] ?? null,
                display: AnswerBlockData.formatValue(row[c.key], c.format, c.signed) })) }));
        return out;
    },

    // A bounded, read-only local agenda. Recurrence, one-day moves and filed
    // next-step evidence use the same record rules as the desktop. No provider
    // fetch or AI work is implied by opening Today.
    schedule(commitments, matters, today, home) {
        if (!CommitmentCalendar.day(today)) return { today: [], overdue: [], coming: [] };
        const days = Array.from({ length: 8 }, (_, i) => {
            const d = new Date(`${today}T12:00:00`);
            d.setDate(d.getDate() + i);
            return CommitmentCalendar.iso(d);
        });
        const byDay = new Map(days.map(date => [date, []]));
        const overdue = [];
        const put = (key, title, date, time, kind) => {
            if (!CommitmentCalendar.day(date)) return;
            const row = { id: `${kind}:${key}:${date}`, key: home(key), title, date, time: CommitmentCalendar.time(time), kind };
            if (date < today) overdue.push(row);
            else if (byDay.has(date)) byDay.get(date).push(row);
        };
        for (const c of commitments) {
            if (c.state !== 'open' || !c.title) continue;
            const key = `task:${c.id}`;
            if (CommitmentCalendar.repeats(c)) {
                for (const day of days) if (CommitmentCalendar.occursOn(c, day) && !CommitmentCalendar.isDone(c, day)) {
                    put(key, c.title, day, CommitmentCalendar.timeOn(c, day).time, 'commitment');
                }
            } else if (!CommitmentCalendar.isDone(c, today)) {
                put(key, c.title, c.when && c.when.date, c.when && c.when.time, 'commitment');
            }
        }
        const taskIds = new Set(commitments.map(c => c.id));
        for (const m of matters) {
            if (m.state !== 'open') continue;
            const step = MatterRecords.openStep(m);
            // A linked commitment is already the person's step, not a second
            // deadline inferred from an old source.
            if (step && !taskIds.has(step.taskId)) put(m.id, MatterRecords.titleOf(m), step.by, step.time, 'step');
            if (m.kind === 'appointment' && m.when && (!step || step.by !== m.when.date)) {
                put(m.id, MatterRecords.titleOf(m), m.when.date, m.when.time, 'appointment');
            }
        }
        const order = rows => rows.sort((a, b) => a.date.localeCompare(b.date) || (a.time || '24:00').localeCompare(b.time || '24:00') || a.id.localeCompare(b.id));
        return { today: order(byDay.get(today)), overdue: order(overdue),
            coming: days.slice(1).map(date => ({ date, items: order(byDay.get(date)) })) };
    }
});
