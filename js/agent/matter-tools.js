/**
 * Matter tools — the assistant reads what nenva keeps track of from mail and
 * texts (docs/MATTERS.md, 2026-10-02): one item per appointment, bill, order,
 * booking or subscription, with its open step and every message filed on it.
 *
 * list_matters and get_matter read. Doing a step stays with the person on
 * Now and the Insights page (M7: nothing is sent, paid or booked by the
 * assistant from here). The two writes are about the folders themselves
 * (2026-10-05, MATTERS.md §15): join_matters when the person says two items
 * are one thing, split_matters to take that back; both ask every time. Registered through AgentTools.register in their own
 * `matters` group, which the model loads with use_tools when it needs it; blocked in untrusted turns (they carry
 * what senders wrote); class `email` for cloud privacy.
 */
(() => {
    if (typeof AgentTools === 'undefined' || typeof AgentTools.register !== 'function') return;

    const KINDS = ['appointment', 'bill', 'order', 'reservation', 'subscription'];
    const brief = (m) => ({
        id: m.id, kind: m.kind, title: Matters.titleOf(m), status: Matters.stepText(m) || m.state,
        state: m.state, when: m.when && m.when.date ? Matters.whenText(m) : undefined,
        next: (() => { const s = Matters.openStep(m); return s ? { what: s.what, by: s.by || undefined } : undefined; })(),
        messages: Matters.messagesOf(m).length
    });
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const titleOf = (id) => { const m = typeof Matters !== 'undefined' ? Matters.get(String(id || '')) : null; return m ? Matters.titleOf(m) : 'an item that is not there'; };
    // Tasks about the folder, read live (done or not, and when).
    const tasksOf = (m) => {
        const ids = [...new Set([...(m.tasks || []), m.next && m.next.taskId].filter(Boolean))];
        if (!ids.length) return undefined;
        let items = [];
        try { items = (StorageManager.get('schedule') || {}).scheduleItems || []; } catch { items = []; }
        const out = ids.map(id => items.find(t => t && t.id === id)).filter(Boolean).map(t => ({
            id: t.id, title: t.title, date: t.scheduledDate || undefined,
            state: t.lastCompletedDate ? 'done' : (t.history && Object.values(t.history).includes('abandoned')) ? 'ignored' : 'open',
            isTheNextStep: !!(m.next && m.next.taskId === t.id) || undefined
        }));
        return out.length ? out : undefined;
    };
    const opts = {
        group: 'matters', blockUntrusted: true, dataClass: 'email'
    };
    AgentTools.GROUP_INFO.matters = 'what nenva tracks from mail and texts: appointments, bills, orders, bookings, subscriptions, with their next steps';

    AgentTools.register({ type: 'function', function: {
        name: 'list_matters',
        description: 'What nenva is keeping track of from the user\'s email and texts: one item per appointment, bill, order, booking or subscription, with its status and next step (e.g. "Waiting for you to confirm", "Due Oct 12", "Ready for pickup"). Use for questions like "which bills are still open?" or "what\'s going on with my orders?".',
        parameters: { type: 'object', properties: {
            kind: { type: 'string', enum: KINDS, description: 'Only this kind' },
            open_only: { type: 'boolean', description: 'Only items with something still open (default true)' },
            search: { type: 'string', description: 'Words in the title, e.g. "dentist", "Cold Stone"' }
        } }
    }}, (args = {}, ctx = {}) => {
        if (typeof Matters === 'undefined') return { error: 'Not available in this build.' };
        let list = (ctx.ambient || ctx.unattended) && Matters.forAmbient ? Matters.forAmbient() : Matters.all();
        if (args.kind) list = list.filter(m => m.kind === args.kind);
        if (args.open_only !== false) list = list.filter(m => m.state === 'open');
        if (args.search) {
            const q = String(args.search).toLowerCase();
            list = list.filter(m => `${Matters.titleOf(m)} ${(m.sources || []).map(s => `${s.from} ${s.summary}`).join(' ')}`.toLowerCase().includes(q));
        }
        list.sort((a, b) => ((a.when && a.when.date) || '9').localeCompare((b.when && b.when.date) || '9'));
        return { count: list.length, items: list.slice(0, 25).map(brief), ...(list.length > 25 ? { note: `Showing 25 of ${list.length}.` } : {}) };
    }, opts);

    AgentTools.register({ type: 'function', function: {
        name: 'get_matter',
        description: 'One tracked item in full, everything nenva knows about it: its facts and next step, every email and text filed on it (sender, date, what it said), the calendar event it is (place, call link, people, your response), the tasks about it (yours and the one its step made, done or open), and its history (calendar moves, tasks done). Use the id from list_matters.',
        parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }
    }}, (args = {}, ctx = {}) => {
        if (typeof Matters === 'undefined') return { error: 'Not available in this build.' };
        const m = Matters.get(String(args.id || ''));
        if (!m) return { error: 'No tracked item with that id. Call list_matters for ids.' };
        if ((ctx.ambient || ctx.unattended) && Matters.needsBounded?.(m)) return { error: 'Slack evidence requires bounded analysis.', blocked: true, blockedClass: 'slack' };
        return {
            ...brief(m),
            place: m.place || undefined, code: m.code || undefined,
            step: m.next ? { what: m.next.what, state: m.next.state, by: m.next.by || undefined, doneBy: m.next.doneBy || undefined,
                ...(m.next.reply ? { reply: m.next.reply } : {}) } : undefined,
            // Mail and texts filed on it, and what the person said about it in its chat (channel "chat").
            messages: (m.sources || []).map(s => ({ from: s.from || s.address, channel: s.kind, at: s.at, said: s.summary })),
            // The rest of the whole thing (2026-10-03): the calendar event it
            // is, the tasks about it, and what happened outside the messages.
            calendar: m.calendar || undefined,
            tasks: tasksOf(m),
            history: (m.log || []).length ? m.log.map(l => ({ at: l.at, from: l.from, what: l.text })) : undefined
        };
    }, opts);

    AgentTools.register({ type: 'function', function: {
        name: 'join_matters',
        description: 'Join two tracked items that are really ONE thing kept twice (the same appointment, bill, order or booking). Use only when the user says they are the same, or asks you to tidy duplicates and both clearly are. Everything on both is kept on one item; the user can split them again.',
        parameters: { type: 'object', properties: {
            a: { type: 'string', description: 'id of one item (from list_matters)' },
            b: { type: 'string', description: 'id of the other' }
        }, required: ['a', 'b'] }
    }}, (args = {}) => {
        if (typeof Matters === 'undefined') return { error: 'Not available in this build.' };
        const r = Matters.merge(String(args.a || ''), String(args.b || ''), { by: 'you' });
        if (!r) return { error: 'Those are not two different tracked items. Call list_matters for ids.' };
        return { joined: true, ...brief(r.keep), note: 'Both are one item now. split_matters with this id takes it back.' };
    }, { ...opts, ask: true, describe: (a) => `Join <b>${esc(titleOf(a.a))}</b> and <b>${esc(titleOf(a.b))}</b> into one item` });

    AgentTools.register({ type: 'function', function: {
        name: 'move_out_of_matter',
        description: 'Take ONE email or text out of a tracked item it was wrongly filed on (the user says "that message is not about this"). The item goes back to how it stood before that message when it was the latest one; the message is then filed afresh on its own. Never for an item\'s only message.',
        parameters: { type: 'object', properties: {
            id: { type: 'string', description: 'id of the item' },
            message: { type: 'integer', description: 'Which message: its position in get_matter\'s "messages" list, starting at 1' }
        }, required: ['id', 'message'] }
    }}, async (args = {}) => {
        if (typeof Matters === 'undefined') return { error: 'Not available in this build.' };
        const m = Matters.get(String(args.id || ''));
        const src = m && (m.sources || [])[Number(args.message) - 1];
        if (!src) return { error: 'No such message on that item. Call get_matter for its messages.' };
        if (src.kind === 'chat') return { error: 'That is something the user said in a chat, not a message. Its Undo is under the answer that filed it.' };
        const out = Matters.pullOut(src.id);
        if (!out) return { error: 'That is the item\'s only message, so it IS the item. Tell the person it is the item itself; their word in this chat (ignore it, done) settles it.' };
        const now = await Matters.refile(src.id).catch(() => null);
        return { movedOut: true, item: brief(out.m), message: { from: src.from || src.address, said: src.summary }, nowOn: now ? brief(now) : 'not kept as an item of its own' };
    }, { ...opts, ask: true, describe: (a) => { const m = Matters.get(String(a.id || '')); const s = m && (m.sources || [])[Number(a.message) - 1];
        return `Take <b>${esc(s ? (s.summary || s.from || 'a message') : 'a message')}</b> out of <b>${esc(titleOf(a.id))}</b>`; } });

    AgentTools.register({ type: 'function', function: {
        name: 'split_matters',
        description: 'Take back the last join on a tracked item: the two items it was made from come back as they were (anything filed since stays on the one that was kept). Use when the user says two joined items are different things.',
        parameters: { type: 'object', properties: { id: { type: 'string', description: 'id of the joined item' } }, required: ['id'] }
    }}, (args = {}) => {
        if (typeof Matters === 'undefined') return { error: 'Not available in this build.' };
        const gone = Matters.lastJoin(String(args.id || ''));
        if (!gone || !Matters.unmerge(gone)) return { error: 'Nothing was joined into that item recently.' };
        return { split: true, items: [Matters.get(String(args.id)), Matters.get(gone)].filter(Boolean).map(brief) };
    }, { ...opts, ask: true, describe: (a) => `Split <b>${esc(titleOf(a.id))}</b> back into the two items it was joined from` });
})();
