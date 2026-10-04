/**
 * Matter tools — the assistant reads what nenva keeps track of from mail and
 * texts (docs/MATTERS.md, 2026-10-02): one item per appointment, bill, order,
 * booking or subscription, with its open step and every message filed on it.
 *
 * Read-only: list_matters and get_matter. Doing a step stays with the person
 * on Now and the Insights page (M7: nothing is sent, paid or booked by the
 * assistant from here). Registered through AgentTools.register in their own
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
        messages: m.sources.length
    });
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
    }}, (args = {}) => {
        if (typeof Matters === 'undefined') return { error: 'Not available in this build.' };
        let list = Matters.all();
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
        description: 'One tracked item in full: its facts, its next step and every email or text filed on it (sender, date, what it said). Use the id from list_matters.',
        parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }
    }}, (args = {}) => {
        if (typeof Matters === 'undefined') return { error: 'Not available in this build.' };
        const m = Matters.get(String(args.id || ''));
        if (!m) return { error: 'No tracked item with that id. Call list_matters for ids.' };
        return {
            ...brief(m),
            place: m.place || undefined, code: m.code || undefined,
            step: m.next ? { what: m.next.what, state: m.next.state, by: m.next.by || undefined, doneBy: m.next.doneBy || undefined,
                ...(m.next.reply ? { reply: m.next.reply } : {}) } : undefined,
            messages: (m.sources || []).map(s => ({ from: s.from || s.address, channel: s.kind, at: s.at, said: s.summary }))
        };
    }, opts);
})();
