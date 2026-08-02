/**
 * ReviewRoutines — shared plumbing for "a routine reviews this record and
 * the record's card quotes the latest review" (the AI-native pattern the
 * Portfolio Strategy page introduced 2026-07-31; Plan's goal detail page
 * uses it too).
 *
 * A review routine is an ordinary routine (NotePrompts note, offline
 * config) whose title follows a convention like "Strategy Review: <name>";
 * its runs post to the Home feed like any other routine, and the owning
 * card shows the newest post as the record's living explanation. Linking
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

    /** Newest successful feed post written by this routine. */
    latestPost(promptId) {
        const d = StorageManager.get('notes');
        const notes = (d && Array.isArray(d.notes)) ? d.notes : [];
        return notes
            .filter(n => NoteTemplates.resolve(n) === 'feed' && n.feed
                && n.feed.promptId === promptId && !n.feed.error)
            .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))[0] || null;
    },

    /** Plain-text excerpt of a feed post for the quoting card. */
    excerpt(post, cap = 320) {
        const tmp = document.createElement('div');
        tmp.innerHTML = post?.content || '';
        const text = (tmp.textContent || '').replace(/\s+/g, ' ').trim();
        return text.length > cap ? text.slice(0, cap).trimEnd() + '…' : text;
    },

    /** Create the routine and nudge the scheduler so it runs soon. */
    start({ title, body, interval = 'weekdays', time = '08:00', web = false, useContext = true }) {
        if (typeof NotePrompts === 'undefined') return null;
        const note = NotePrompts.create({ title, body,
            config: { offline: true, interval, time, web, useContext } });
        if (typeof PromptFeed !== 'undefined' && PromptFeed.onPromptsChanged) PromptFeed.onPromptsChanged();
        return note;
    },

    /** Delete the routine; past feed posts stay. */
    stop(routineId) {
        if (typeof NotePrompts === 'undefined') return;
        NotePrompts.remove(routineId);
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

        // Prompt bodies are stored as HTML with &<> escaped (quotes are not),
        // so the quoted needle matches the content string directly for any
        // machine-authored body; the escaped form covers titles carrying &<>.
        const esc = (s) => String(s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const conventionOld = (prefix + from).toLowerCase();

        const notes = NotePrompts._readNotes();
        let changed = false;
        for (const n of notes) {
            if (!n || !NotePrompts.isRoutine(n)) continue;
            const title = n.title || '';
            const content = n.content || '';
            const isConvention = title.trim().toLowerCase() === conventionOld;
            const replaceIn = (s) => s
                .split(`"${from}"`).join(`"${to}"`)
                .split(`"${esc(from)}"`).join(`"${esc(to)}"`);
            const hasQuoted = replaceIn(title) !== title || replaceIn(content) !== content;

            if (isConvention || hasQuoted) {
                n.title = isConvention ? prefix + to : replaceIn(title);
                n.content = replaceIn(content);
                n.modifiedAt = new Date().toISOString();
                out.updated.push(n.title);
                changed = true;
            } else if (title.toLowerCase().includes(from.toLowerCase())
                || NotePrompts.bodyText(n).toLowerCase().includes(from.toLowerCase())) {
                out.mentions.push(title || 'Untitled routine');
            }
        }
        if (changed) {
            NotePrompts._writeNotes(notes);
            if (typeof PromptFeed !== 'undefined' && PromptFeed.onPromptsChanged) {
                PromptFeed.onPromptsChanged();
            }
        }
        return out;
    }
};
