/**
 * Card tools — the chat behind a card on Now can set that card aside
 * (2026-10-03). A card's box opens the THING's chat (todayKey), and the
 * person talks there: "just ignore it" used to get "Dropped." while the card
 * stayed, because no tool reached the card. `set_card_aside` runs the card's
 * own quiet button (Ignore / Not now / Show later / Don't ask) through
 * SimpleExperience.letGoFromChat, and only ever on THIS chat's card: the
 * card is the chat's todayKey, never a model-supplied id.
 *
 * Group `nowcard`, hidden from the use_tools catalog; AgentService adds it
 * to a chat that is tied to a card. No ask: it does what the card's own
 * button does, at the person's word, and nothing leaves the Mac.
 */
(() => {
    if (typeof AgentTools === 'undefined' || typeof AgentTools.register !== 'function') return;

    AgentTools.GROUP_INFO.nowcard = 'the card on Now this chat is about';
    if (AgentTools.HIDDEN_GROUPS) AgentTools.HIDDEN_GROUPS.add('nowcard');

    AgentTools.register({ type: 'function', function: {
        name: 'set_card_aside',
        description: 'This chat is about a card on the person\'s Now page. When they tell you to ignore it, drop it, skip it, forget it or stop showing it, call this with for_good true: the card goes away for good (like its Ignore / Not now button). Only when they say later, not now, or remind me, call it with for_good false: it comes back later (like Show later). When they say not to show, to ignore or to skip messages LIKE this one from now on, that covers this card too: call this with for_good true in the same turn as saving the preference, and never ask whether to drop the card as well. Never say a card was dropped or ignored without calling this.',
        parameters: { type: 'object', properties: {
            for_good: { type: 'boolean', description: 'true (the usual): gone for good, the person said ignore / drop / skip / stop. false: only when they asked for later.' }
        }, required: ['for_good'] }
    }}, (args = {}, ctx = {}) => {
        if (typeof SimpleExperience === 'undefined' || typeof AgentService === 'undefined') return { error: 'Not available in this build.' };
        const conv = ctx.convId ? (AgentService.conversations || []).find(c => c.id === ctx.convId) : null;
        const res = SimpleExperience.letGoFromChat(conv && conv.todayKey, args.for_good !== false);
        return res.done && res.title ? { ...res, changed: `Set aside on Now: "${res.title}" (${res.how}).` } : res;
    }, { group: 'nowcard' });
})();
