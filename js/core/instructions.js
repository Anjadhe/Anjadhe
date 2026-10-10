/**
 * Instructions — a routine read by a watcher that already exists
 * (docs/ROUTINES_UX.md "Routines are instructions", I2; step 3, 2026-10-09).
 *
 * A routine whose subject nenva already watches carries `watcher` in its
 * config: 'mail' (mail and texts, read by the Matters filing call) or
 * 'money' (read by the money coach). Its sentence is put in front of that
 * watcher as one of the person's standing instructions, labelled [I1]…;
 * nothing reads the same mailbox or portfolio a second time.
 *
 *   - An instruction with no stated time rides the watcher's own pace (every
 *     message for mail, the coach's looks for money).
 *   - A money instruction with a stated time (I1) is fired by the engine at
 *     that time and runs the coach's look then, focused on it
 *     (PromptFeed._runWatcher). A mail instruction never fires on a clock:
 *     mail is read as it arrives.
 *   - When the watcher acts on one (a message filed under it, a card the
 *     coach raised for it), the routine's chat gets one line saying what
 *     was done (`record`), so its history stays where the person reads it.
 *
 * Pure: lines, idOf, signature. Pinned by tests/instructions-test.js.
 */
const Instructions = {
    WATCHERS: ['mail', 'money'],
    LABEL: { mail: 'their mail and texts', money: 'their money' },
    MAX: 8,

    /** Armed routines a watcher reads: [{ id, title, body, when }] (when = its stated time, or null). */
    forWatcher(watcher) {
        if (typeof NotePrompts === 'undefined' || !this.WATCHERS.includes(watcher)) return [];
        try {
            return NotePrompts.list().filter(r => {
                const c = NotePrompts.config(r);
                return c.offline && c.watcher === watcher && NotePrompts.bodyText(r).trim();
            }).slice(0, this.MAX).map(r => {
                const c = NotePrompts.config(r);
                const timed = c.trigger && c.trigger.type === 'time' && c.trigger.time;
                return { id: r.id, title: r.title || '', body: NotePrompts.bodyText(r).slice(0, 600), when: timed ? NotePrompts.scheduleLabel(c) : null };
            });
        } catch { return []; }
    },

    /** The instructions as prompt lines, labelled I1…. Pure. */
    lines(list) {
        return (list || []).map((x, i) => `[I${i + 1}] ${x.title ? `${x.title}: ` : ''}${String(x.body).replace(/\s+/g, ' ').trim()}${x.when ? ` (asked for ${x.when})` : ''}`);
    },

    /** The id behind a label a model wrote ("I2", "[I2]"), or null. Pure. */
    idOf(label, list) {
        const m = /^\[?I(\d+)\]?$/i.exec(String(label || '').trim());
        const x = m ? (list || [])[Number(m[1]) - 1] : null;
        return x ? x.id : null;
    },

    /** Changes when an instruction is added, edited or removed (a watcher's look is due again). Pure. */
    signature(list) {
        return (list || []).map(x => `${x.id}:${x.title}:${x.body}:${x.when || ''}`).join('|');
    },

    /**
     * What a watcher did for an instruction, in the routine's chat: one
     * line, never a Now card of its own (the folder or the coach's card is
     * the card). Stamps the run and clears a failure streak.
     */
    record(id, { headline, body = '' } = {}) {
        if (typeof NotePrompts === 'undefined' || !id || !headline) return null;
        const h = String(headline).replace(/\s+/g, ' ').trim().slice(0, 120);
        const b = String(body || '').trim();
        const run = NotePrompts.appendRun(id, { content: b ? `${h}\n\n${b}` : h, look: { headline: h, changes: [], card: false } });
        try { if (typeof RoutineEngine !== 'undefined') { RoutineEngine.stampRun(id); RoutineEngine.clearFailure(id); } } catch { /* the line is written */ }
        return run;
    }
};

if (typeof module !== 'undefined') module.exports = Instructions;
