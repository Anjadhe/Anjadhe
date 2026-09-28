/**
 * "While you were away" — what your routines DID, and what is waiting.
 *
 * docs/ROUTINES_UX.md U5 and U6. A digest's output is content and goes to
 * the feed; an acting run's report is a LOG and does not (C10's law, and it
 * stands). What P5 adds is that a log still deserves a SURFACE — just not
 * that one. Before this, a `runMode:'task'` routine could act all night and
 * the only trace on home was nothing at all; its report lived on a detail
 * page the user had no other reason to visit, and a run PAUSED on an `ask`
 * sat behind a nav click on the Routines page.
 *
 * Two kinds of row, in this order:
 *
 *   waiting — a run that stopped to ask something nobody was there to
 *             answer. This is the urgent one: until it is answered the
 *             routine has not finished. It renders until it is resolved,
 *             and it is what makes the card `alert`.
 *   acted   — a run that finished and changed something, within the last
 *             day and since the last time the user looked at this card.
 *
 * It is the Focus-mode shape ("While you focused", the held notices
 * released as one summary) applied to the app's other absence, and it obeys
 * the widget contract: with nothing waiting and nothing new since the last
 * clear, `load()` returns null and home shows no card at all.
 *
 * The acknowledgement is per-Mac (`localStorage`), like the ⌘K usage counts
 * and the side-nav collapse: "I have seen this" is a fact about a person at
 * a screen, not about the account, and syncing it would clear the card on a
 * Mac whose user never looked.
 */
(function () {
    if (typeof Widgets === 'undefined') return;

    const ACK_KEY = 'routines-widget-ack';

    const ackAt = () => {
        try { return Date.parse(localStorage.getItem(ACK_KEY) || '') || 0; }
        catch { return 0; }
    };
    const setAck = () => {
        try { localStorage.setItem(ACK_KEY, new Date().toISOString()); } catch { /* private window */ }
    };

    // A routine's title can BE its prompt (nothing forces a short name), and
    // an untitled one swamps the row it is supposed to label.
    const NAME_MAX = 38;
    const routineTitle = (id) => {
        if (!id || typeof NotePrompts === 'undefined') return 'A routine';
        const n = NotePrompts.list().find(p => p.id === id);
        const t = String((n && n.title) || '').replace(/\s+/g, ' ').trim();
        if (!t) return 'A routine';
        return t.length > NAME_MAX ? t.slice(0, NAME_MAX).replace(/\s+\S*$/, '') + '…' : t;
    };

    // The "Changed:" line TaskService already writes on a settled run — the
    // one sentence that says what a run did, rather than that it ran.
    const changedLine = (t) => {
        const from = String(t.report || t.note || '');
        const m = from.match(/^\s*Changed:\s*(.+)$/mi);
        if (m) return m[1].trim().slice(0, 120);
        return String(t.note || '').trim().slice(0, 120);
    };

    Widgets.register('routines-away', {
        title: 'While you were away',
        app: 'prompts',
        order: 6,   // under the live focus session, over the inventory cards
        load() {
            if (typeof TaskService === 'undefined' || typeof TaskService._all !== 'function') return null;
            const all = TaskService._all() || [];
            const mine = all.filter(t => t && t.routineId);

            const waiting = mine.filter(t => ['awaiting_user', 'paused'].includes(t.status));
            // Two floors, and both are needed. The ACK is "I have seen
            // this" and comes from the user opening the card; the 24-hour
            // horizon is what keeps a card the user never clicks from
            // nagging forever about a run that is no longer news. "While
            // you were away" is a claim about a recent absence.
            const since = Math.max(ackAt(), Date.now() - 24 * 60 * 60 * 1000);
            const acted = mine
                .filter(t => t.status === 'done' || t.status === 'failed')
                .filter(t => (Date.parse(t.updatedAt) || 0) > since)
                .sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0))
                .slice(0, 4);

            // The widget rule, by construction: nothing waiting and nothing
            // new means no card, not an empty one.
            if (!waiting.length && !acted.length) return null;

            const when = (t) => (typeof PromptFeed !== 'undefined' && PromptFeed._timeAgo)
                ? PromptFeed._timeAgo(t.updatedAt) : '';

            const rows = [
                ...waiting.map(t => ({
                    sub: 'waiting',
                    text: `${routineTitle(t.routineId)} — ${String(t.note || 'needs your answer').slice(0, 100)}`,
                    flag: 'Asks you',
                    actions: [{ action: 'open', id: t.id, label: 'Review', title: 'Open the routine and answer it' }]
                })),
                ...acted.map(t => ({
                    sub: when(t),
                    subQuiet: true,
                    text: `${routineTitle(t.routineId)}${changedLine(t) ? ' — ' + changedLine(t) : ''}`,
                    flag: t.status === 'failed' ? 'Did not finish' : '',
                    actions: [{ action: 'open', id: t.id, label: 'Log', title: 'Open the routine\'s run history' }]
                }))
            ];

            return Widgets.fromData({
                rows,
                count: waiting.length || acted.length,
                tone: waiting.length ? 'alert' : undefined,
                title: waiting.length ? 'Waiting on you' : 'While you were away'
            });
        },
        onAction(action, id) {
            if (action !== 'open') return;
            setAck();
            const t = (TaskService._all() || []).find(x => x && x.id === id);
            AppManager.openApp('prompts');
            if (t && t.routineId && typeof PromptsApp !== 'undefined') PromptsApp.open({ id: t.routineId });
        },
        onOpen() {
            // The header is the door to the page that holds both halves —
            // "Waiting on you" and every routine's run history. Opening it
            // is also the acknowledgement: the runs stay in each routine's
            // history, and only this card forgets them.
            setAck();
            AppManager.openApp('prompts');
        }
    });
})();
