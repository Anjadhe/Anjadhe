/**
 * Now tools — the assistant reads what the person sees on Now (2026-10-08,
 * docs/AI_NATIVE.md: "whatever a person can SEE in nenva the assistant can
 * READ through a tool"). Before this, "what's on my Now?" and "why is this
 * card here?" could not be answered from any chat: the cards were built for
 * the page and never offered to the model.
 *
 * read_now returns the same cards the page draws (SimpleExperience.cards:
 * the open raises joined with their live cards), each with the key a chat
 * about it carries (`thingKey`), its kind, its words, where it came from and
 * its buttons, plus the lede and Today's rows. Read-only; acting on a card
 * goes through the record's own tools (commitments, matters) or its chat.
 * Blocked in untrusted turns and classed `email` for cloud privacy: a card
 * carries words read from mail and texts.
 */
(() => {
    if (typeof AgentTools === 'undefined' || typeof AgentTools.register !== 'function') return;

    const clean = (v, n = 300) => String(v == null ? '' : v).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, n);

    AgentTools.GROUP_INFO.now = 'what is on the person\'s Now page: the cards in front of them and why each is there, and Today\'s rows';

    AgentTools.register({ type: 'function', function: {
        name: 'read_now',
        description: 'What the person sees on Now right now: the cards (each with its key, kind, title, the line that says why it is there, where it came from and its buttons, in the order shown), the line at the top, and Today\'s rows. Call it for "what\'s on my Now?", "why is this card here?", "what needs me?" or before talking about a card the person mentions. Read-only: to act on a card use the tools for its record (a commitment\'s id is in the key "task:<id>", a folder\'s in "matter:<id>").',
        parameters: { type: 'object', properties: {} }
    }}, () => {
        if (typeof SimpleExperience === 'undefined' || !SimpleExperience.cards) return { error: 'Now is not available.' };
        const now = new Date();
        let cards = [];
        try { cards = (SimpleExperience.deckCards ? SimpleExperience.deckCards(now) : SimpleExperience.cards(now)) || []; } catch { cards = []; }
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
        try { const l = SimpleExperience.ledeLine(now); if (l) out.lede = clean(l, 200); } catch { /* left out */ }
        try {
            const items = SimpleExperience.todayItems(now) || [];
            out.today = items.slice(0, 20).map(i => ({ time: clean(i.time, 20) || undefined, title: clean(i.title, 120), help: i.help && i.help.line ? clean(i.help.line, 160) : undefined }));
            const line = SimpleExperience.todayLine(items, now);
            if (line) out.todayLine = clean(line, 200);
        } catch { /* left out */ }
        if (!out.cards.length) out.note = 'Nothing is waiting on Now.';
        return out;
    }, { group: 'now', readOnly: true, blockUntrusted: true, dataClass: 'email' });
})();
