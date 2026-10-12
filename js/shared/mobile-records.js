'use strict';
// Native record adapter: local blobs in, shared timeline values out. It never
// writes records, starts work, or treats delivery as a request to execute.
const MobileRecords = Object.freeze({
    snapshot(blobs, today, now = Date.now()) {
        const senders = blobs.senders || {};
        const data = { senders: senders.senders || {}, place: senders.place || {}, aliases: senders.aliases || {} };
        const matters = Object.values((blobs.matters || {}).matters || {}).filter(m => !(m.privacySources || []).includes('slack'));
        const seen = senders.threadSeen || {};
        const hidden = senders.threadHidden || {};
        const commitments = ((blobs.commitments || {}).items || []).filter(c => !(c.privacySources || []).includes('slack') && !(c.origin && c.origin.kind === 'plan'));
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
        const rows = Object.values(data.senders).filter(s => s.state !== 'archived').map(s => {
            const children = members.filter(r => owner(r.key) === s.id);
            const items = ThreadCore.senderTimeline(s, children, conv(s.id));
            return { key: s.id, title: s.name, facts: s.allGood || '', items,
                info: info(children),
                at: ThreadCore.lastEventAt(items), unread: ThreadCore._unread(items, ThreadCore.lastEventAt(items), seen, s.id) };
        });
        const reminders = members.filter(r => r.type === 'commitment' && !owner(r.key) && SenderMembership.isToDo(r.rec, commitments));
        const reminderKeys = new Set(reminders.map(r => r.key));
        for (const r of members) if (!owner(r.key) && !reminderKeys.has(r.key)) rows.push({ ...r, info: info([r]), unread: ThreadCore._unread(r.items, r.at, seen, r.key) });
        const reminder = SenderMembership.reminders();
        const reminderItems = ThreadCore.senderTimeline(reminder, reminders, conv(reminder.id));
        const reminderRow = { key: reminder.id, title: reminder.name, facts: reminder.allGood, items: reminderItems,
            info: info(reminders) };
        // Existing untied conversations remain reachable inside nenva's thread.
        const general = conversations.filter(c => !c.todayKey || c.todayKey === 'nenva');
        const nenva = { key: 'nenva', title: 'nenva', facts: '', items: [], conversations: general, at: 0 };
        const due = commitments.filter(c => c.state === 'open' && !CommitmentCalendar.isDone(c, today) &&
            (CommitmentCalendar.repeats(c) ? CommitmentCalendar.occursOn(c, today) : c.when && c.when.date && c.when.date <= today))
            .map(c => ({ key: owner(`task:${c.id}`) || (reminderKeys.has(`task:${c.id}`) ? reminder.id : `task:${c.id}`), title: c.title, when: ThreadCore.commitmentWhen(c) }));
        return { threads: [nenva, reminderRow, ...ThreadCore.order(rows.filter(r => !hidden[r.key])).map(r => ({ ...r, preview: ThreadCore.preview(r.items) }))], due };
    }
});
