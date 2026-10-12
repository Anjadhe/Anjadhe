/**
 * ReviewRoutines — shared plumbing for "a routine reviews this record and
 * the record's card quotes the latest review" (the AI-native pattern the
 * Portfolio Strategy page introduced 2026-07-31; Plan's goal detail page
 * uses it too).
 *
 * A review routine is an ordinary routine (a Standing chat read through
 * NotePrompts, offline config) whose title follows a convention like
 * "Strategy Review: <name>"; its runs land in its chat like any other
 * routine's, and the owning card shows the newest as the record's living
 * explanation. Linking
 * is BY TITLE on purpose — no ids stored on the reviewed record — so
 * every record rename path calls syncRename() below to carry the routine
 * along (same note id, so past feed reviews keep their series). A rename
 * that bypasses those paths still just orphans the routine harmlessly
 * (the card offers to start again).
 */
const ReviewRoutines = {
    /** The routine with exactly this title (case-insensitive), if any. */
    find(title) {
        if (typeof NotePrompts === 'undefined') return null;
        const needle = String(title || '').trim().toLowerCase();
        if (!needle) return null;
        return NotePrompts.list().find(n =>
            NotePrompts.config(n).offline && (n.title || '').trim().toLowerCase() === needle) || null;
    },

    /** Newest successful run of this routine (a NotePrompts run card). */
    latestPost(promptId) {
        if (typeof NotePrompts === 'undefined') return null;
        return NotePrompts.runs(promptId).find(r => !r.error) || null;
    },

    /** Plain-text excerpt of a run (its Markdown, stripped) for the quoting card. */
    excerpt(post, cap = 320) {
        const text = String(post?.content || '')
            .replace(/```[\s\S]*?```/g, ' ')
            .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
            .replace(/^\s*[-*>#|]+\s*/gm, '')
            .replace(/[*_`~]+/g, '')
            .replace(/\s+/g, ' ').trim();
        return text.length > cap ? text.slice(0, cap).trimEnd() + '…' : text;
    },

    /** Create the routine and nudge the scheduler so it runs soon. */
    start({ title, body, interval = 'weekdays', time = '08:00', web = false, useContext = true, about = [] }) {
        if (typeof NotePrompts === 'undefined') return null;
        // `about` is the real link to the record this reviews
        // (js/apps/prompts/routine-about.js). The title prefix stays as the
        // lookup for routines written before the field, but a review armed
        // from here carries the id, so a rename can no longer break it.
        const config = { offline: true, interval, time, web, useContext, about };
        // A review stopped earlier is still there, disarmed, holding its past
        // reviews in its chat (stop() below): start it again rather than
        // making a second routine of the same name.
        const want = String(title || '').trim().toLowerCase();
        const paused = NotePrompts.list().find(n => !NotePrompts.config(n).offline
            && (n.title || '').trim().toLowerCase() === want);
        const note = paused
            ? NotePrompts.update(paused.id, { body, config })
            : NotePrompts.create({ title, body, config });
        if (typeof RoutineEngine !== 'undefined') RoutineEngine.onRoutinesChanged();
        return note;
    },

    /**
     * The routine that reviews THIS record, by reference. Preferred over
     * `find(title)` everywhere: a routine that carries the id is found
     * after any rename, on either side.
     */
    findFor(type, id) {
        if (typeof RoutineAbout === 'undefined') return null;
        return RoutineAbout.forRecord(type, id)[0] || null;
    },

    /**
     * Stop the reviews. The routine is DISARMED, not deleted (2026-10-07):
     * its past reviews are messages in its chat now, and "past reviews
     * stay" is the promise the stop makes. start() re-arms it.
     */
    stop(routineId) {
        if (typeof NotePrompts === 'undefined') return;
        NotePrompts.update(routineId, { config: { offline: false } });
        if (typeof RoutineEngine !== 'undefined') RoutineEngine.onRoutinesChanged();
    },

    /**
     * Follow a record rename. Two tiers, and the split is deliberate:
     *
     *   - UPDATED automatically: the "<prefix><oldTitle>" convention routine
     *     itself, and any offline routine whose title or body contains the
     *     EXACT QUOTED old title ("Run a 10K…") — a quoted title is an
     *     unambiguous reference to the record, so rewriting it is
     *     referential integrity, not editing the user's prose. The routine
     *     keeps its id, so past feed posts stay in its series.
     *   - MENTIONS reported, never touched: routines that merely contain the
     *     old title unquoted. Callers surface these (tool result / toast)
     *     so the user decides.
     *
     * Returns { updated: [titles], mentions: [titles] }.
     */
    syncRename(prefix, oldTitle, newTitle) {
        const out = { updated: [], mentions: [] };
        if (typeof NotePrompts === 'undefined') return out;
        const from = String(oldTitle || '').trim();
        const to = String(newTitle || '').trim();
        if (!from || !to || from === to) return out;

        // Prompt bodies are plain text (the Standing chat's `standing.body`),
        // so the quoted needle matches the body directly; the escaped form
        // still covers a body written before 2026-10-07 that carried &<>.
        const esc = (s) => String(s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const conventionOld = (prefix + from).toLowerCase();

        let changed = false;
        for (const n of NotePrompts.list()) {
            if (!NotePrompts.isRoutine(n)) continue;
            const title = n.title || '';
            const body = NotePrompts.bodyText(n);
            const isConvention = title.trim().toLowerCase() === conventionOld;
            const replaceIn = (s) => s
                .split(`"${from}"`).join(`"${to}"`)
                .split(`"${esc(from)}"`).join(`"${esc(to)}"`);
            const hasQuoted = replaceIn(title) !== title || replaceIn(body) !== body;

            if (isConvention || hasQuoted) {
                const newTitle = isConvention ? prefix + to : replaceIn(title);
                NotePrompts.update(n.id, { title: newTitle, body: replaceIn(body) });
                out.updated.push(newTitle);
                changed = true;
            } else if (title.toLowerCase().includes(from.toLowerCase())
                || body.toLowerCase().includes(from.toLowerCase())) {
                out.mentions.push(title || 'Untitled routine');
            }
        }
        if (changed && typeof RoutineEngine !== 'undefined') {
            RoutineEngine.onRoutinesChanged();
        }
        return out;
    }
};
