/**
 * Now tools — the assistant reads what is in front of the person (2026-10-08,
 * docs/AI_NATIVE.md: "whatever a person can SEE in nenva the assistant can
 * READ through a tool"). Before this, "what needs me?" and "why is this card
 * here?" could not be answered from any chat: the cards were built for the
 * page and never offered to the model.
 *
 * read_now returns the cards as the threads draw them (SimpleExperience.cards:
 * the open raises joined with their live cards; since docs/SENDERS.md M7 each
 * is the newest bubble of its thread, and the Now page itself left
 * 2026-10-11), each with the key a chat about it carries (`thingKey`), its
 * kind, its words, where it came from and its buttons, plus Today's rows as
 * nenva's thread shows them. Read-only; acting on a card goes through the
 * record's own tools (commitments, matters) or its chat. Blocked in untrusted
 * turns and classed `email`: a card carries words read from mail and texts.
 */
(() => {
    if (typeof AgentTools === 'undefined' || typeof AgentTools.register !== 'function') return;

    const clean = (v, n = 300) => String(v == null ? '' : v).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, n);

    AgentTools.GROUP_INFO.now = 'what is in front of the person right now: the open cards in their threads and why each is there, and Today\'s rows';

    AgentTools.register({ type: 'function', function: {
        name: 'read_now',
        description: 'What is in front of the person right now: the open cards (each with its key, kind, title, the line that says why it is there, where it came from and its buttons; each card is the newest bubble of its thread on the Threads page) and Today\'s rows at the top of nenva\'s thread. Call it for "what needs me?", "why is this card here?" or before talking about a card the person mentions. Read-only: to act on a card use the tools for its record (a commitment\'s id is in the key "task:<id>", a folder\'s in "matter:<id>").',
        parameters: { type: 'object', properties: {} }
    }}, () => {
        if (typeof SimpleExperience === 'undefined' || !SimpleExperience.cards) return { error: 'The cards are not available.' };
        const now = new Date();
        let cards = [];
        try { cards = SimpleExperience.cards(now) || []; } catch { cards = []; }
        const out = {
            cards: cards.map(c => ({
                key: SimpleExperience.thingKey(c) || c.key,
                kind: c.kind,
                title: clean(c.title, 160),
                why: clean(c.body) || undefined,
                source: (SimpleExperience.sourceOf && SimpleExperience.sourceOf(c)) || undefined,
                buttons: [c.primary, ...(Array.isArray(c.choices) ? c.choices.map(x => (x && x.label) || x) : []), c.dismiss].map(b => clean(b, 40)).filter(Boolean),
                reopened: c.reopened && c.reopened.why ? clean(c.reopened.why, 160) : undefined
            }))
        };
        if (SimpleExperience._heldCount) out.waiting = `${SimpleExperience._heldCount} more will show once the mail being read now is filed.`;
        try {
            const items = SimpleExperience.todayItems(now) || [];
            out.today = items.slice(0, 20).map(i => ({ time: clean(i.time, 20) || undefined, title: clean(i.title, 120), help: i.help && i.help.line ? clean(i.help.line, 160) : undefined }));
            const line = SimpleExperience.todayLine(items, now);
            if (line) out.todayLine = clean(line, 200);
        } catch { /* left out */ }
        if (!out.cards.length) out.note = 'No card is waiting on the person.';
        return out;
    }, { group: 'now', readOnly: true, blockUntrusted: true, dataClass: 'email' });
})();
