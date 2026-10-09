/**
 * Preference tools — the assistant makes the same choices the person makes
 * with a tap (2026-10-08, docs/AI_NATIVE.md: "whatever a person can DO the
 * assistant can DO through a tool").
 *
 * A preference is a Memory sentence with its value in `meta` (PrefAsks).
 * Before this, "stop writing the market brief" in a chat could only reach
 * save_memory / update_memory, which change the WORDS and leave the value
 * (or drop it), so the sentence said one thing and the app did another.
 * set_preference writes through PrefAsks.set, the same door as the tap: the
 * sentence and the value move together, and the toast announces it.
 *
 * stop_asking is the card's "Don't ask about this": AskAfter.stop for a
 * commitment, CheckIns.respond(…, 'stop') for a check-in. Each writes its
 * own flag AND its Memory sentence, which save_memory alone cannot.
 *
 * No approval (the person's own stated choice, announced with the sentence;
 * Memory shows it with the other choices to change it back), but blocked in
 * untrusted turns: a hostile email must not flip a preference.
 */
(() => {
    if (typeof AgentTools === 'undefined' || typeof AgentTools.register !== 'function') return;
    const opts = { group: 'memory', blockUntrusted: true };

    const choicesOf = (d) => d.choices.map(c => ({ value: c.value, label: c.label, sentence: c.sentence }));

    AgentTools.register({ type: 'function', function: {
        name: 'list_preferences',
        description: 'The preferences nenva acts on (when to remind, when morning routines run, whether to write the market brief, CNBC headlines…), each with its id, the question, the current choice and the choices there are. Read before set_preference.',
        parameters: { type: 'object', properties: {} }
    }}, () => {
        if (typeof PrefAsks === 'undefined') return { error: 'Preferences are not available.' };
        const out = [];
        for (const d of PrefAsks._defs.values()) {
            const v = PrefAsks.value(d.id);
            const cur = d.choices.find(c => c.value === v);
            out.push({ id: d.id, question: d.question, current: cur ? cur.label : (v == null ? 'not chosen yet' : String(v)), chosenByPerson: PrefAsks.answered(d.id), choices: choicesOf(d) });
        }
        return { preferences: out };
    }, { ...opts, readOnly: true });

    AgentTools.register({ type: 'function', function: {
        name: 'set_preference',
        description: 'Change one of nenva\'s preferences when the person says so ("stop writing the market brief", "remind me a day before"). Use this, never save_memory or update_memory, for anything list_preferences lists: it changes what the app does AND writes the sentence to Memory. Choose one of the preference\'s own choices.',
        parameters: { type: 'object', properties: {
            id: { type: 'string', description: 'The preference id from list_preferences' },
            choice: { type: 'string', description: 'The chosen option: its label or its value, from list_preferences' }
        }, required: ['id', 'choice'] }
    }}, (a = {}) => {
        if (typeof PrefAsks === 'undefined') return { error: 'Preferences are not available.' };
        const d = PrefAsks.def(String(a.id || ''));
        if (!d) return { error: 'No preference with that id. Call list_preferences for the ids.' };
        const want = String(a.choice == null ? '' : a.choice).trim().toLowerCase();
        const c = d.choices.find(x => String(x.value).toLowerCase() === want || String(x.label).toLowerCase() === want);
        if (!c) return { error: `Not one of the choices for "${d.question}"`, choices: choicesOf(d) };
        if (!PrefAsks.set(d.id, c.value, { source: 'assistant' })) return { error: 'Could not save it.' };
        return { success: true, id: d.id, now: c.label, sentence: c.sentence };
    }, { ...opts, describe: (a) => `Preference <b>${String(a.id || '').replace(/[&<>"]/g, '')}</b>: ${String(a.choice || '').replace(/[&<>"]/g, '')}` });

    AgentTools.register({ type: 'function', function: {
        name: 'stop_asking',
        description: 'The person does not want to be asked about something any more: "how did it go?" questions after a commitment (give commitment_id), or a check-in on Now (give its key from read_now, "checkin:<subject>"). Same as the card\'s "Don\'t ask about this": it stops the question and writes the preference to Memory.',
        parameters: { type: 'object', properties: {
            commitment_id: { type: 'string', description: 'Stop "how did it go?" for this commitment' },
            checkin: { type: 'string', description: 'A check-in card key from read_now, e.g. "checkin:habit:…"' }
        } }
    }}, (a = {}) => {
        if (a.commitment_id) {
            if (typeof AskAfter === 'undefined' || typeof Commitments === 'undefined') return { error: 'Not available.' };
            const c = Commitments.get(String(a.commitment_id));
            if (!c) return { error: 'No commitment with that id. Call list_commitments for ids.' };
            AskAfter.stop(c.id);
            return { success: true, stopped: `asking how "${c.title}" went` };
        }
        if (a.checkin) {
            if (typeof CheckIns === 'undefined') return { error: 'Not available.' };
            const subject = String(a.checkin).replace(/^checkin:/, '');
            const known = (CheckIns.state().cards || []).find(x => x.subject === subject);
            if (!known) return { error: 'No check-in with that key on Now. Call read_now for the keys.' };
            CheckIns.respond(subject, 'stop');
            if (typeof SimpleExperience !== 'undefined' && SimpleExperience.render) { try { SimpleExperience.render(); } catch { /* the stop holds */ } }
            return { success: true, stopped: `checking in about ${known.name || known.title || subject}` };
        }
        return { error: 'Give commitment_id or checkin.' };
    }, opts);
})();
