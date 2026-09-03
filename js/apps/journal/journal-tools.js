/**
 * Journal — the package's contribution to the assistant.
 *
 * The three journal tools, the vocabulary that summons them, the ⌘K /
 * search_all source, and the journal record-link type all register HERE,
 * from the package's own folder (docs/PLATFORM.md "App packages").
 * Nothing in js/agent/ or js/core/ names the journal tools any more; the
 * ambient context provider stays in journal-app.js beside the data it
 * reads, and the home nudge stays in AppManager (it hides itself when the
 * package is uninstalled).
 *
 * Loads AFTER the assistant stack (BundledApps loads package scripts after
 * every core module). Handlers stay reachable as AgentTools.handlers.<name>.
 */

(function registerJournalTools() {
    if (typeof AgentTools === 'undefined') return;

    const SOURCE = 'journal';
    const GROUP = 'journal';

    /**
     * An entry's LOCAL day as YYYY-MM-DD. The Journal app stamps `date`
     * with a full ISO timestamp (UTC), the agent's create_journal_entry
     * stamps a bare day, and both coexist in the same blob. Comparing the
     * raw string against a YYYY-MM-DD bound silently dropped the whole
     * last day of a range ('2026-08-28T14:05Z' > '2026-08-28'), which is
     * how "read today's entry" found nothing (2026-08-28). A timestamp is
     * resolved to the user's local day, so a late-evening entry stays on
     * the day it was written rather than tomorrow's UTC date.
     */
    function journalDay(entry) {
        const raw = String(entry?.date || '');
        if (!/T/.test(raw)) return raw.slice(0, 10);
        const d = new Date(raw);
        if (isNaN(d)) return raw.slice(0, 10);
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${d.getFullYear()}-${m}-${day}`;
    }

    AgentTools.registerDomain(GROUP, /\b(journals?|diar\w+|mood|feelings?)\b/);

    AgentTools.register({
        type: 'function', function: {
            name: 'list_journal',
            description: 'List journal entries, newest first (date, mood, tags, opening snippet); optional date range, inclusive, in the user\'s local days. Snippets are only the first ~200 chars — call get_journal_entry to read what an entry actually SAYS before reflecting on or suggesting anything about it.',
            parameters: { type: 'object', properties: {
                date_from: { type: 'string', description: 'YYYY-MM-DD (local day, inclusive)' },
                date_to: { type: 'string', description: 'YYYY-MM-DD (local day, inclusive)' }
            }}
        }
    }, function list_journal(args = {}) {
        const data = StorageManager.get('journal');
        let entries = (data?.entries || []).filter(Boolean);

        const from = String(args.date_from || '').slice(0, 10);
        const to = String(args.date_to || '').slice(0, 10);
        if (from) entries = entries.filter(e => journalDay(e) >= from);
        if (to) entries = entries.filter(e => journalDay(e) <= to);

        // Newest first — the app unshifts, but synced/merged blobs and
        // hand-picked dates make stored order unreliable, and the 20-row
        // cap must never hide today's entry behind old ones.
        entries.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));

        const total = entries.length;
        const out = entries.slice(0, 20).map(e => {
            const text = AgentTools.noteHtmlToMd(e.content || '');
            return {
                id: e.id,
                date: journalDay(e),
                mood: e.mood,
                tags: Array.isArray(e.tags) && e.tags.length ? e.tags : undefined,
                snippet: text.length > 200 ? text.slice(0, 200) + '…' : text,
                chars: text.length,
            };
        });
        const result = { entries: out, total };
        if (total > out.length) result.note = `Showing the newest ${out.length} of ${total}; narrow with date_from/date_to.`;
        if (out.some(e => e.chars > 200)) result.readNote = 'Snippets are truncated — call get_journal_entry with an id for the full text.';
        return result;
    }, { source: SOURCE, group: GROUP, dataClass: 'journal' });

    AgentTools.register({
        type: 'function', function: {
            name: 'get_journal_entry',
            description: 'Read one journal entry\'s full content by id. Use this whenever the answer depends on what the entry SAYS — list_journal and search_all give you the id and a snippet, never the whole body. Returns the body in pages (up to ~5000 chars); pass offset to continue a truncated entry.',
            parameters: { type: 'object', properties: {
                id: { type: 'string', description: 'Entry id from list_journal or search_all' },
                offset: { type: 'number', description: 'Character offset to continue from (default 0)' }
            }, required: ['id'] }
        }
    }, function get_journal_entry(args, ctx) {
        const data = StorageManager.get('journal');
        const entries = data?.entries || [];
        const entry = entries.find(e => e && (e.id === args.id || String(e.id) === String(args.id)));
        if (!entry) return { error: `No journal entry with id ${args.id}. Call list_journal or search_all to get valid ids.` };

        // The get_note mould: markdown (structure survives), paged inside
        // the 6k result budget, decisions mounted under the record key.
        const text = AgentTools.noteHtmlToMd(entry.content || '');
        const start = Math.max(0, parseInt(args.offset, 10) || 0);
        const result = {
            id: entry.id,
            date: journalDay(entry),
            mood: entry.mood,
            tags: Array.isArray(entry.tags) ? entry.tags : [],
            format: 'markdown',
            content: '',
            offset: start,
            totalChars: text.length,
            truncated: false,
        };
        AgentTools._withDecisions(result, [{ key: `journal:${entry.id}`, into: result }], ctx);

        const overhead = JSON.stringify(result).length;
        let slice = text.slice(start, start
            + Math.max(1000, Math.min(AgentTools.NOTE_READ_CAP, 5600 - overhead)));
        result.content = slice;
        while (slice.length > 500 && JSON.stringify(result).length > 5800) {
            slice = slice.slice(0, Math.floor(slice.length * 0.9));
            result.content = slice;
        }
        result.truncated = start + slice.length < text.length;
        if (result.truncated) {
            result.contentNote = `Content is ${text.length} chars; showing ${slice.length} from offset ${start}. Call get_journal_entry again with offset ${start + slice.length} to continue.`;
        }
        return result;
    }, { sources: (args, res) => (res.id ? [{ key: `journal:${res.id}`, title: `Journal — ${res.date || ''}`.trim() }] : []),
         source: SOURCE, group: GROUP, dataClass: 'journal' });

    AgentTools.register({
        type: 'function', function: {
            name: 'create_journal_entry',
            description: 'Create a journal entry.',
            parameters: { type: 'object', properties: {
                content: { type: 'string' },
                mood: { type: 'string', enum: ['happy', 'sad', 'neutral', 'grateful', 'anxious'] },
                date: { type: 'string', description: 'YYYY-MM-DD. Default: today.' }
            }, required: ['content'] }
        }
    }, function create_journal_entry(args) {
        const data = StorageManager.get('journal') || {};
        const entries = data.entries || [];
        const now = new Date();
        const date = args.date || UIUtils.todayISO(now);

        const newEntry = {
            id: UIUtils.generateId(),
            date: date,
            title: '',
            // SECURITY (H5): the journal viewer renders content as raw HTML
            // (innerHTML). Model-supplied content is prompt-injectable (from
            // email/web the agent processes), so sanitize it the same way
            // create_note does — mdToNoteHtml escapes and whitelists tags,
            // turning `<img onerror=…>` into inert text instead of a live
            // element that would execute on render and sync to other Macs.
            content: AgentTools.mdToNoteHtml(args.content),
            mood: args.mood || 'neutral',
            tags: [],
            createdAt: now.toISOString(),
            modifiedAt: now.toISOString()
        };

        entries.unshift(newEntry);
        StorageManager.set('journal', { entries });
        if (typeof AppManager !== 'undefined' && AppManager.currentApp === 'journal'
            && typeof JournalApp !== 'undefined') {
            JournalApp.loadEntries(); JournalApp.render();
        }

        return { success: true, entry: { id: newEntry.id, date: newEntry.date, mood: newEntry.mood } };
    }, { source: SOURCE, group: GROUP, record: { app: 'journal', key: 'entry', label: 'Journal' } });

    // ⌘K + search_all rows (was a hardcoded loop in GlobalSearch.data).
    if (typeof GlobalSearch !== 'undefined' && GlobalSearch.registerSource) {
        GlobalSearch.registerSource(SOURCE, {
            label: 'Journal',
            index(push) {
                const entries = (StorageManager.get('journal')?.entries) || [];
                for (const e of entries) {
                    if (!e) continue;
                    push('journal', e.id, e.title || e.date, e.content,
                        { snippet: String(e.content || '').replace(/<[^>]*>/g, '').slice(0, 120), meta: {} });
                }
            },
            open(hit) {
                AppManager.openApp('journal');
                setTimeout(() => JournalApp.openViewer?.(hit.id), 0);
            }
        });
    }

    // Inline record links: [journal:<id>] in assistant replies.
    if (typeof RecordLinks !== 'undefined' && RecordLinks.register) {
        RecordLinks.register('journal', {
            label: 'journal entry',
            exists: (id) => ((StorageManager.get('journal')?.entries) || [])
                .some(e => e && String(e.id) === String(id)),
            open(id) { RecordLinks._into('journal', () => typeof JournalApp !== 'undefined' && JournalApp.openEditor?.(id)); }
        });
    }
})();
