/**
 * Triage tools — the buttons on Now cards, folder pages and Insights, for
 * the assistant in ANY chat (2026-10-08, docs/AI_NATIVE.md parity
 * inventory, batch 3). Before this, Show later / Ignore / Done on a card
 * worked only through ThingCapture inside that card's own chat, and muting
 * a sender or saying "not useful" reached only an undocumented memory
 * convention.
 *
 * Every tool calls the SAME function the button calls, so the record-side
 * effect, the Memory sentence and the toast are the button's own:
 *   set_card_aside      → SimpleExperience.letGoFromChat (Show later /
 *                         Ignore / Don't ask, per the card)
 *   finish_matter_step  → Matters.markStep
 *   ignore_matter       → Matters.ignore (its task goes with it)
 *   mute_sender         → EmailApp.muteSenderOf / unmuteSender
 *   insight_feedback    → EmailApp.recordInsightFeedback (the sentence the
 *                         insight pass reads)
 *   delete_insight      → EmailApp.deleteInsight
 *   answer_work_plan    → WorkPlans.accept / decline / replan / unarrange
 *
 * Asking: what the person settles about their own things in their own
 * words (a card aside, a step done, a folder ignored, "not useful") runs
 * without a dialog, like ThingCapture, and the turn's Undo takes it back.
 * What changes the future or removes something (mute a sender, delete what
 * nenva kept from a message, schedule or remove work sessions) asks. All
 * are blocked in untrusted turns: a hostile message must not triage the
 * person's things. Nothing here sends, pays or books (MATTERS.md M7).
 */
(() => {
    if (typeof AgentTools === 'undefined' || typeof AgentTools.register !== 'function') return;

    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const repaint = () => { try { if (typeof SimpleExperience !== 'undefined' && SimpleExperience.render) SimpleExperience.render(); } catch { /* the change holds */ } };
    const matter = (id) => (typeof Matters !== 'undefined' ? Matters.get(String(id || '')) : null);
    const matterTitle = (id) => { const m = matter(id); return m ? Matters.titleOf(m) : String(id || ''); };
    const emailOf = (id) => (typeof EmailApp !== 'undefined' && EmailApp.emailById ? EmailApp.emailById(String(id || '')) : null);
    const quiet = { group: 'triage', blockUntrusted: true };
    const asks = { group: 'triage', blockUntrusted: true, ask: true };

    AgentTools.GROUP_INFO.triage = 'act on the cards on Now and on folders from mail and texts: set a card aside, mark a folder\'s step done, ignore a folder, mute a sender, "not useful", delete what nenva kept from a message, answer a suggested work plan';

    AgentTools.register({ type: 'function', function: {
        name: 'set_card_aside',
        description: 'Set a card on Now aside, as its own quiet button does: for now ("later", "not now") or for good ("ignore it", "stop showing this", "don\'t ask about this"). Give the card\'s key from read_now. A card waiting for the person to approve something cannot be set aside.',
        parameters: { type: 'object', properties: {
            key: { type: 'string', description: 'The card key from read_now, e.g. "matter:…", "task:…", "checkin:…"' },
            for_good: { type: 'boolean', description: 'true: for good (Ignore / Don\'t ask). false: for now (Show later).' },
            quote: { type: 'string', description: 'What the person said, verbatim' }
        }, required: ['key', 'for_good'] }
    }}, (a = {}) => {
        if (typeof SimpleExperience === 'undefined' || !SimpleExperience.letGoFromChat) return { error: 'Now is not available.' };
        const r = SimpleExperience.letGoFromChat(String(a.key || ''), !!a.for_good, { quote: a.quote ? String(a.quote).slice(0, 300) : null });
        if (r.error) return { error: r.error };
        repaint();
        return r.title ? { success: true, card: r.title, how: r.how } : { success: true, note: r.note };
    }, quiet);

    AgentTools.register({ type: 'function', function: {
        name: 'finish_matter_step',
        description: 'Mark a folder\'s open step done when the person says they did it ("I paid it", "I replied", "booked"). Its task is completed with it. Nothing is sent or paid from here.',
        parameters: { type: 'object', properties: { id: { type: 'string', description: 'The folder id from list_matters / get_matter' } }, required: ['id'] }
    }}, (a = {}) => {
        const m = matter(a.id);
        if (!m) return { error: 'No folder with that id. Call list_matters.' };
        if (!m.next || m.next.state !== 'open') return { error: 'This folder has no open step.', status: Matters.stepText(m) || m.state };
        const what = m.next.what;
        Matters.markStep(m.id, null, 'done', 'chat');
        repaint();
        return { success: true, folder: Matters.titleOf(m), done: what };
    }, { ...quiet, describe: (a) => `Mark the step done on <b>${esc(matterTitle(a.id))}</b>` });

    AgentTools.register({ type: 'function', function: {
        name: 'ignore_matter',
        description: 'Ignore a folder when the person is letting it go ("not going", "ignore that bill reminder"): it closes quietly, its step is skipped and its task dropped; nothing is sent. The turn\'s Undo puts it back.',
        parameters: { type: 'object', properties: { id: { type: 'string', description: 'The folder id' } }, required: ['id'] }
    }}, (a = {}) => {
        const m = matter(a.id);
        if (!m) return { error: 'No folder with that id. Call list_matters.' };
        if (m.state === 'ignored') return { success: true, note: 'Already ignored.' };
        Matters.ignore(m.id);
        repaint();
        return { success: true, ignored: Matters.titleOf(m) };
    }, { ...quiet, describe: (a) => `Ignore <b>${esc(matterTitle(a.id))}</b>` });

    AgentTools.register({ type: 'function', function: {
        name: 'mute_sender',
        description: 'Never show email from a sender again ("mute them", "stop showing anything from this address"), or undo that. Give a message id (from get_matter messages) to mute its sender, or an address with unmute:true. Writes the sentence to Memory › Email, which the email reader follows.',
        parameters: { type: 'object', properties: {
            message_id: { type: 'string', description: 'An email id whose sender to mute' },
            address: { type: 'string', description: 'For unmute: the sender\'s address' },
            unmute: { type: 'boolean' }
        } }
    }}, (a = {}) => {
        if (typeof EmailApp === 'undefined') return { error: 'Email is not available.' };
        if (a.unmute) {
            const addr = String(a.address || '').trim().toLowerCase();
            if (!addr) return { error: 'Give the address to unmute.' };
            EmailApp.unmuteSender(addr);
            return { success: true, unmuted: addr };
        }
        const e = emailOf(a.message_id);
        if (!e) return { error: 'No email with that id. Use a message id from get_matter (messages[].id).' };
        const addr = EmailApp.senderAddress(e);
        if (!addr) return { error: 'That message has no sender address.' };
        EmailApp.muteSenderOf(e.id);
        return { success: true, muted: addr };
    }, { ...asks, describe: (a) => {
        if (a.unmute) return `Show email from <b>${esc(a.address)}</b> again`;
        const e = emailOf(a.message_id);
        return `Never show email from <b>${esc(e && typeof EmailApp !== 'undefined' ? EmailApp.senderAddress(e) : 'this sender')}</b>`;
    } });

    AgentTools.register({ type: 'function', function: {
        name: 'insight_feedback',
        description: 'The person\'s verdict on what nenva showed from one email: useful:false for "not useful" / "don\'t show me these" (nenva stops showing that kind from that sender unless they have to act), useful:true for "keep showing me these". Writes the sentence to Memory › Email. Give a message id from get_matter.',
        parameters: { type: 'object', properties: {
            message_id: { type: 'string' },
            useful: { type: 'boolean' }
        }, required: ['message_id', 'useful'] }
    }}, (a = {}) => {
        if (typeof EmailApp === 'undefined') return { error: 'Email is not available.' };
        const e = emailOf(a.message_id);
        if (!e || !EmailApp.priorityAnalyses || !EmailApp.priorityAnalyses[e.id]) return { error: 'nenva kept nothing from that message. Use a message id from get_matter (messages[].id).' };
        EmailApp.recordInsightFeedback(e.id, !!a.useful);
        return { success: true, useful: !!a.useful, sender: EmailApp.senderAddress(e) || undefined };
    }, quiet);

    AgentTools.register({ type: 'function', function: {
        name: 'delete_insight',
        description: 'Delete what nenva kept from one message (its summary, folder entry and card), when the person asks. The email itself is not touched, and tasks it created stay.',
        parameters: { type: 'object', properties: { message_id: { type: 'string' } }, required: ['message_id'] }
    }}, (a = {}) => {
        if (typeof EmailApp === 'undefined') return { error: 'Email is not available.' };
        const id = String(a.message_id || '');
        if (!EmailApp.deleteInsight(id)) return { error: 'nenva kept nothing from that message.' };
        repaint();
        return { success: true, deleted: id };
    }, { ...asks, describe: (a) => {
        const e = emailOf(a.message_id);
        return `Delete what nenva kept from <b>${esc(e ? (e.subject || 'this message') : 'this message')}</b>`;
    } });

    AgentTools.register({ type: 'function', function: {
        name: 'answer_work_plan',
        description: 'Answer the work plan nenva suggested for a commitment (get_commitment shows it as workPlan): "schedule" adds the proposed sessions, "not_needed" drops the suggestion, "replan" clears missed sessions and looks again, "undo_sessions" removes the sessions it scheduled and does not plan that one again. For OTHER times, talk it through and add the sessions with add_commitment instead.',
        parameters: { type: 'object', properties: {
            id: { type: 'string', description: 'The commitment (task) id' },
            answer: { type: 'string', enum: ['schedule', 'not_needed', 'replan', 'undo_sessions'] }
        }, required: ['id', 'answer'] }
    }}, (a = {}) => {
        if (typeof WorkPlans === 'undefined') return { error: 'Work plans are not available.' };
        const id = String(a.id || '');
        const r = WorkPlans._state().byTask[id];
        if (!r) return { error: 'nenva has no work plan for that commitment.' };
        if (a.answer === 'schedule') {
            if (r.status !== 'proposed') return { error: `The plan is ${r.status}, not waiting for an answer.` };
            const n = WorkPlans.accept(id);
            return n ? { success: true, scheduled: n } : { error: 'Could not schedule the sessions.' };
        }
        if (a.answer === 'not_needed') { WorkPlans.decline(id); return { success: true, declined: r.title }; }
        if (a.answer === 'replan') { WorkPlans.replan(id); return { success: true, note: 'Missed sessions cleared; nenva will look at it again.' }; }
        if (a.answer === 'undo_sessions') { const n = WorkPlans.unarrange(id); return { success: true, removed: n }; }
        return { error: 'answer must be schedule, not_needed, replan or undo_sessions.' };
    }, { ...asks, describe: (a) => {
        const r = typeof WorkPlans !== 'undefined' ? (WorkPlans._state().byTask[String(a.id || '')] || {}) : {};
        const what = { schedule: 'Schedule the suggested work sessions', not_needed: 'Drop the suggested work plan', replan: 'Clear the missed sessions and plan again', undo_sessions: 'Remove the scheduled work sessions' }[a.answer] || 'Answer the work plan';
        return `${what} for <b>${esc(r.title || a.id)}</b>`;
    } });
})();
