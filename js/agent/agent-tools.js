/**
 * Agent Tools - Tool definitions and execution for the LLM agent
 * Provides CRUD operations across all apps via StorageManager
 */

function formatTime12h(timeStr) {
    if (!timeStr) return null;
    const [h, m] = timeStr.split(':').map(Number);
    const suffix = h >= 12 ? 'PM' : 'AM';
    const hour = h % 12 || 12;
    return `${hour}:${String(m).padStart(2, '0')} ${suffix}`;
}

function getDateStr(offset) {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Calendar-day arithmetic on local YYYY-MM-DD strings (same clock as
// getDateStr). The bulk shift rides these: the model states intent
// ("first task lands today"), the app computes every date.
function addDaysISO(iso, days) {
    const [y, m, d] = iso.split('-').map(Number);
    const dt = new Date(y, m - 1, d + days);
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}
function daysBetweenISO(fromISO, toISO) {
    const [fy, fm, fd] = fromISO.split('-').map(Number);
    const [ty, tm, td] = toISO.split('-').map(Number);
    return Math.round((new Date(ty, tm - 1, td) - new Date(fy, fm - 1, fd)) / 86400000);
}

// Abandoned = deliberately not done — resolved exactly like completed, the
// user isn't going to work on it anymore. Recurring: per-occurrence mark;
// one-time: any abandoned mark resolves the task for good.
function isAbandonedOnDate(item, dateStr) {
    return !!(item.history && item.history[dateStr] === 'abandoned');
}
function isOneTimeAbandoned(item) {
    if (item.repeat && item.repeat !== 'none') return false;
    return !!item.history && Object.values(item.history).includes('abandoned');
}

function isItemForDate(item, dateStr) {
    const today = getDateStr(0);

    // Recurring items — occurrence-tested (respects the start-date anchor);
    // an occurrence abandoned on that day is resolved, not pending.
    if (item.repeat && item.repeat !== 'none') {
        return ScheduleApp.occursOn(item, dateStr) && !isAbandonedOnDate(item, dateStr);
    }

    // One-time abandoned items are resolved for every date.
    if (isOneTimeAbandoned(item)) return false;

    // One-time items: if checking today, skip items completed on a previous day
    // For future dates, don't apply this filter — the item is still scheduled
    if (dateStr === today && item.lastCompletedDate && item.lastCompletedDate !== dateStr) {
        return false;
    }

    const itemDate = item.scheduledDate || (item.createdAt ? item.createdAt.slice(0, 10) : null);
    return itemDate === dateStr;
}

const AgentTools = {

    // Chars per get_note call. Matches AGENT_FS_READ_CAP (main.js) — same
    // context-budget tradeoff, and the agent already knows the offset dance
    // from fs_read. Successive slices carry different offsets, so they are
    // distinct calls and the identical-call caps never see them; only
    // totalToolHardBreak bounds how many a turn can take.
    NOTE_READ_CAP: 6000,

    /**
     * Note bodies are contenteditable HTML, not plain text. Flatten to text a
     * model can read, turning block boundaries into newlines FIRST — plain
     * textContent runs an itinerary's list items together into one line.
     * DOMParser gives an inert document, so nothing in a note's own markup
     * executes or fetches while we read it.
     */
    _noteText(note) {
        const html = (note && note.content) || '';
        if (!html) return '';
        if (!/[<&]/.test(html)) return html.trim();
        const spaced = html.replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/td|\/th)\b[^>]*>/gi, '\n$&');
        const doc = new DOMParser().parseFromString(spaced, 'text/html');
        return (doc.body?.textContent || '')
            .replace(/[ \t]+\n/g, '\n')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
    },

    /**
     * Note HTML → markdown, for reads that feed an EDIT (get_note, the
     * CURRENT NOTE context block). _noteText's plain-text flatten is right
     * for snippets, but an edit round-trips: the model rewrites what it was
     * shown and update_note stores it back — so a read that drops the
     * headings/lists/bold guarantees the write drops them too ("every time
     * the assistant updates a note it loses the formatting", 2026-08-09).
     * The dialect matches what mdToNoteHtml can write back: #-headings,
     * bold/italic markers, `-`/`1.` lists (2-space nesting), > quotes,
     * fenced code, [text](href), tables, ---, ~~strike~~. Underline/highlight have no
     * markdown and survive as plain text; images become "(image)" — get_note
     * flags those notes so the model prefers append over replace.
     */
    noteHtmlToMd(html) {
        if (!html) return '';
        if (!/[<&]/.test(html)) return String(html).trim();
        const doc = new DOMParser().parseFromString(String(html), 'text/html');
        const BLOCKS = new Set(['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
            'ul', 'ol', 'blockquote', 'pre', 'table', 'hr']);
        const hasBlockChildren = (el) => [...el.children].some(c => BLOCKS.has(c.tagName.toLowerCase()));

        const tableMd = (tbl) => {
            const rows = [...tbl.querySelectorAll('tr')].map(tr =>
                [...tr.children].map(c => this._mdInline(c).replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ').trim()));
            if (!rows.length) return null;
            const md = ['| ' + rows[0].join(' | ') + ' |',
                        '| ' + rows[0].map(() => '---').join(' | ') + ' |'];
            for (const r of rows.slice(1)) md.push('| ' + r.join(' | ') + ' |');
            return md.join('\n');
        };
        const listMd = (listEl, indent) => {
            const pad = '  '.repeat(indent);
            const lines = [];
            let n = 0;
            for (const li of listEl.children) {
                if (li.tagName.toLowerCase() !== 'li') continue;
                n++;
                const marker = listEl.tagName.toLowerCase() === 'ol' ? `${n}. ` : '- ';
                const clone = li.cloneNode(true);
                clone.querySelectorAll('ul, ol').forEach(x => x.remove());
                lines.push(pad + marker + this._mdInline(clone).replace(/\s*\n\s*/g, ' ').trim());
                for (const sub of li.children) {
                    const t = sub.tagName.toLowerCase();
                    if (t === 'ul' || t === 'ol') lines.push(listMd(sub, indent + 1));
                }
            }
            return lines.join('\n');
        };
        const renderBlock = (el) => {
            const t = el.tagName.toLowerCase();
            const h = t.match(/^h([1-6])$/);
            if (h) return '#'.repeat(+h[1]) + ' ' + this._mdInline(el).replace(/\s*\n\s*/g, ' ').trim();
            if (t === 'ul' || t === 'ol') return listMd(el, 0);
            if (t === 'pre') return '```\n' + el.textContent.replace(/\n$/, '') + '\n```';
            if (t === 'hr') return '---';
            if (t === 'img') return '(image)';   // top-level, not wrapped in a <p>
            if (t === 'table') return tableMd(el);
            if (t === 'blockquote') {
                const inner = hasBlockChildren(el)
                    ? [...el.children].map(renderBlock).filter(Boolean).join('\n')
                    : this._mdInline(el).trim();
                return inner ? inner.split('\n').map(l => '> ' + l).join('\n') : null;
            }
            if (t === 'div' && el.classList.contains('agent-codeblock')) {
                // mdToNoteHtml's fenced-code wrapper (header bar + pre): read
                // back as a fence, not as a "code Copy" paragraph.
                const pre = el.querySelector('pre');
                return pre ? '```\n' + pre.textContent.replace(/\n$/, '') + '\n```' : null;
            }
            if ((t === 'p' || t === 'div') && hasBlockChildren(el)) {
                // contenteditable wrapper div — recurse rather than flatten.
                return [...el.children].map(renderBlock).filter(Boolean).join('\n\n') || null;
            }
            const text = this._mdInline(el).trim();
            return text || null;
        };

        const out = [];
        for (const node of doc.body.childNodes) {
            if (node.nodeType === 3) {              // stray top-level text
                const text = node.textContent.trim();
                if (text) out.push(text);
            } else if (node.nodeType === 1) {
                const block = renderBlock(node);
                if (block) out.push(block);
            }
        }
        return out.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
    },

    /** Inline half of noteHtmlToMd: element children → markdown spans. */
    _mdInline(node) {
        let out = '';
        for (const child of node.childNodes) {
            if (child.nodeType === 3) { out += child.textContent; continue; }
            if (child.nodeType !== 1) continue;
            const t = child.tagName.toLowerCase();
            const body = () => this._mdInline(child);
            if (t === 'br') { out += '\n'; continue; }
            if (t === 'strong' || t === 'b') { const b = body().trim(); out += b ? `**${b}**` : ''; continue; }
            if (t === 'em' || t === 'i') { const b = body().trim(); out += b ? `*${b}*` : ''; continue; }
            if (t === 's' || t === 'strike' || t === 'del') { const b = body().trim(); out += b ? `~~${b}~~` : ''; continue; }
            if (t === 'code') { out += '`' + child.textContent + '`'; continue; }
            if (t === 'a') {
                const href = child.getAttribute('href') || '';
                const label = body().trim() || href;
                out += /^(https?:|mailto:|anjadhe:)/i.test(href) ? `[${label}](${href})` : label;
                continue;
            }
            if (t === 'img') { out += '(image)'; continue; }
            out += body();       // u/mark/span/sub/sup — the text survives
        }
        return out;
    },


    /**
     * OpenAI-compatible tool definitions for the LLM.
     *
     * These get serialized into the chat prompt on every call, so length here
     * directly translates to prompt-eval time on local models. Keep descriptions
     * terse — the detailed behavior rules (safety confirmations, hierarchy,
     * formatting expectations) live in the system prompt in agent-service.js
     * instead of being repeated in every tool description. Parameter names are
     * usually self-explanatory; only add a description when the name alone
     * doesn't convey format, default, or non-obvious semantics.
     */
    definitions: [
        // READ
        { type: 'function', function: {
            name: 'list_goals',
            description: 'List projects with their group and open linked tasks, optionally filtered. A project is active, a draft (interview unfinished), or completed — progress lives in its tasks.',
            parameters: { type: 'object', properties: {
                due_within: { type: 'string', enum: ['today', 'week', 'month', 'year'], description: 'Only projects with a target date inside this horizon (overdue included)' },
                include_completed: { type: 'boolean' }
            }}
        }},
        { type: 'function', function: {
            name: 'list_schedule',
            description: 'List scheduled tasks/events. Pass filter matching user intent: "today", "tomorrow", "yesterday", "week", "all", or YYYY-MM-DD. Default: today. To find a specific task, pass search instead — it matches every date, immune to long-list truncation. To work with a PROJECT\'s plan, pass goal — every open task linked to that project with its id and date, all dates, not truncated at big-project sizes.',
            parameters: { type: 'object', properties: {
                search: { type: 'string', description: '1-3 distinctive keywords (e.g. "movie tickets") — case-insensitive word match on title/description, all dates' },
                filter: { type: 'string', description: '"today" | "tomorrow" | "yesterday" | "week" | "all" | YYYY-MM-DD' },
                goal: { type: 'string', description: 'Project title or id — list that project\'s open linked tasks instead (filter is ignored; search still narrows)' }
            }}
        }},
        { type: 'function', function: {
            name: 'list_notes',
            description: 'List notes (title + opening snippet); optional keyword search. Snippets are only the first few lines — call get_note to read a note\'s actual content.',
            parameters: { type: 'object', properties: {
                search: { type: 'string' }
            }}
        }},
        { type: 'function', function: {
            name: 'get_note',
            description: 'Read one note\'s full content by id. Use this whenever the answer depends on what a note SAYS — list_notes and search_all give you the id and title, never the body. Returns the body in pages (up to ~5000 chars); pass offset to continue a truncated note.',
            parameters: { type: 'object', properties: {
                id: { type: 'string', description: 'Note id from list_notes or search_all' },
                offset: { type: 'number', description: 'Character offset to continue from (default 0)' }
            }, required: ['id'] }
        }},
        // journal tools: registered by the Journal package, js/apps/journal/journal-tools.js

        { type: 'function', function: {
            name: 'web_search',
            description: 'Web search for info not in the user\'s data (news, current events, product specs, live stats). Returns {title, url, snippet}.',
            parameters: { type: 'object', properties: {
                query: { type: 'string', description: 'User\'s question verbatim; only rewrite to expand ambiguous abbreviations (CA→California) or add a year for time-bound queries. Keep it short (under 400 chars): ONE thing per call — to look up several items, make several web_search calls, never pack a list into one query.' },
                maxResults: { type: 'number', description: 'Default 5, max 10' }
            }, required: ['query'] }
        }},
        { type: 'function', function: {
            name: 'read_url',
            description: 'Fetch a web page and return its readable text (nav/ads stripped). PDF links work too — the document is extracted to text locally. Use AFTER web_search to read the 1–2 most promising results — snippets are often too thin to answer from — or when the user gives a URL. Pass `find` to center the excerpt on the part you need. If the result says truncated, call again with a sharper `find`.',
            parameters: { type: 'object', properties: {
                url: { type: 'string', description: 'The http(s) page to read' },
                find: { type: 'string', description: 'What to look for on the page (e.g. "return policy", "2025 revenue") — focuses the excerpt there instead of the top of the page.' }
            }, required: ['url'] }
        }},
        { type: 'function', function: {
            // When-to-use lives in the system prompt's THINK block (always
            // shipped alongside this core tool) — not duplicated here.
            name: 'think',
            description: 'Pause to reason privately before a hard step (destructive action, surprising result, multi-step plan). No side effects; the user never sees it.',
            parameters: { type: 'object', properties: {
                thought: { type: 'string', description: 'A few sentences of reasoning. Plain prose, no markdown.' }
            }, required: ['thought'] }
        }},
        { type: 'function', function: {
            name: 'search_all',
            description: 'Search across projects, notes, journal, tasks, bookmarks, the wellness log, and portfolio accounts/properties. Results are ranked, best match first. Note hits may carry kind "routine", "routine result", or "saved prompt" — those are scheduled prompts and their machine-written output posts, NOT the user\'s own records; never treat one as an account, task, or personal note.',
            parameters: { type: 'object', properties: {
                query: { type: 'string' }
            }, required: ['query'] }
        }},
        { type: 'function', function: {
            // Enum stays in sync with HelpDocs.docs (help-docs.js) — the
            // handler validates against the live corpus, so a drifted enum
            // degrades to the index rather than erroring.
            name: 'get_help',
            description: 'The built-in Anjadhe user guide. Call for ANY question about Anjadhe itself — how to use a feature, where a setting lives, what something does — and answer from the returned doc, never from guesses about the UI. Topics: getting-started (first steps), your-day (Actions/Tasks/Plan), the-assistant (chat, memory, modes, routines), ai-models (local/server/API-key models, switching), ai-activity (what the AI engine is doing, GPU use, activity page), web-search (search keys), news (News page, topics), connected-accounts (Gmail/Calendar/Apple apps/iMessage), telegram (chatting with the assistant from Telegram, step by step), everyday-apps (Notes/Journal/Bookmarks/Portfolio), how-anjadhe-works (privacy, sync, profiles, shortcuts, building apps), license (what Anjadhe costs, the free alpha license, claiming or entering a key), settings (map of every Settings section).',
            parameters: { type: 'object', properties: {
                topic: { type: 'string', enum: ['getting-started', 'your-day', 'the-assistant', 'ai-models', 'cloud-privacy', 'ai-activity', 'web-search', 'news', 'connected-accounts', 'telegram', 'everyday-apps', 'how-anjadhe-works', 'license', 'settings'], description: 'The closest topic. Omit to get the topic index.' }
            }}
        }},
        { type: 'function', function: {
            name: 'get_setup_status',
            description: 'What is actually set up on THIS Mac right now: connected Google accounts (Gmail/Calendar), the AI model in use, whether web search is on, whether multi-Mac sync is on, and which setup steps are still pending. Call this BEFORE answering any "how do I set up / connect / enable …", "am I connected?", "what should I do first?", or "why can\'t it see my email/calendar/the web?" question, so the answer fits what the user has already done instead of restarting them from scratch.',
            parameters: { type: 'object', properties: {} }
        }},

        // WRITE
        { type: 'function', function: {
            name: 'create_goal',
            description: 'Create a bare project record directly. Only for quick captures the user dictated in full — when the user wants to SET or PLAN a project, use start_goal_interview instead.',
            parameters: { type: 'object', properties: {
                title: { type: 'string' },
                description: { type: 'string', description: 'What done looks like, measurably' },
                targetDate: { type: 'string', description: 'Target date YYYY-MM-DD (optional)' },
                group: { type: 'string', description: 'Life bucket the project is shown under, e.g. "Work", "Health" — prefer an existing group' }
            }, required: ['title'] }
        }},
        { type: 'function', function: {
            name: 'update_goal',
            description: 'Update a project. Find by search (title) or id.',
            parameters: { type: 'object', properties: {
                search: { type: 'string' },
                id: { type: 'string' },
                new_title: { type: 'string' },
                targetDate: { type: 'string', description: 'Target date YYYY-MM-DD, or "" to clear' },
                group: { type: 'string', description: 'Life bucket, e.g. "Work" — "" to ungroup' },
                completed: { type: 'boolean', description: 'A project is either completed or it is not; progress lives in its linked tasks' }
            }, required: ['search'] }
        }},
        { type: 'function', function: {
            name: 'start_goal_interview',
            description: 'Begin or resume the guided intake that turns a conversation into a project with a task timeline. Returns the agenda, the next question to ask, and the user\'s existing groups and projects for context. Call this FIRST whenever the user wants to set, create, or plan a project — the agenda is fixed, do not improvise your own questions.',
            parameters: { type: 'object', properties: {
                title: { type: 'string', description: 'Existing/draft project to continue; omit to start a new one' }
            }}
        }},
        { type: 'function', function: {
            name: 'save_goal',
            description: 'Create or update a project. Merges — pass only the fields just agreed and call again as the interview proceeds, so an interrupted conversation still leaves a usable draft. tasks[] creates schedule items linked to the project (titles it already has are skipped). Everything saved must be something the user actually said or approved. Returns what is still missing.',
            parameters: { type: 'object', properties: {
                title: { type: 'string', description: 'Project title — the key for create-or-update' },
                new_title: { type: 'string', description: 'Rename the project' },
                description: { type: 'string', description: 'What done looks like, measurably, in the user\'s words' },
                why: { type: 'string', description: 'Why it matters to them right now' },
                targetDate: { type: 'string', description: 'YYYY-MM-DD' },
                group: { type: 'string', description: 'Life bucket, e.g. "Work" — prefer an existing group from context.groups' },
                obstacles: { type: 'string', description: 'What is most likely to get in the way' },
                status: { type: 'string', enum: ['draft', 'not-started', 'completed'], description: 'A project is active, a draft, or completed — nothing in between; progress lives in its tasks' },
                tasks: { type: 'array', description: 'The task timeline. Confirm titles and dates with the user before saving; spread dates toward the target date.', items: { type: 'object', properties: {
                    title: { type: 'string', description: 'One concrete action starting with a verb' },
                    date: { type: 'string', description: 'YYYY-MM-DD (optional — omit for an undated plan step)' },
                    repeat: { type: 'string', enum: ['daily', 'weekdays', 'weekly'], description: 'For recurring habit tasks only' }
                }}},
                startWeeklyReview: { type: 'boolean', description: 'Create the weekly AI review routine for this project (only after the user says yes)' },
                changeNote: { type: 'string', description: 'One line for the change log, e.g. "Moved the date out after injury"' }
            }, required: ['title'] }
        }},
        { type: 'function', function: {
            name: 'delete_goal',
            description: 'Permanently delete a project AND every task linked to it — the tasks are deleted first, then the project. Tell the user what will go (the project and how many tasks) and get their explicit go-ahead before calling. search must match exactly one project (≥3 chars), else candidates are returned; pass id to disambiguate.',
            parameters: { type: 'object', properties: {
                search: { type: 'string' },
                id: { type: 'string' }
            }}
        }},
        { type: 'function', function: {
            name: 'update_schedule_item',
            description: 'Update ONE scheduled task/event. Find by search (title) or id. To move the dates of MANY tasks at once (a project\'s whole plan), call shift_schedule_items — never loop this tool for that.',
            parameters: { type: 'object', properties: {
                search: { type: 'string' },
                id: { type: 'string' },
                new_title: { type: 'string' },
                description: { type: 'string', description: 'Notes / details for the task' },
                startTime: { type: 'string', description: 'HH:MM (24h), or "" to clear the time' },
                endTime: { type: 'string', description: 'HH:MM (24h)' },
                scheduledDate: { type: 'string', description: 'YYYY-MM-DD, or "today"/"tomorrow"' },
                repeat: { type: 'string', enum: ['once', 'daily', 'weekdays', 'weekly'] }
            }, required: ['search'] }
        }},
        { type: 'function', function: {
            name: 'shift_schedule_items',
            description: 'Shift the dates of MANY scheduled tasks in ONE atomic operation — the app computes every new date and keeps the tasks\' spacing. THE tool for "start this project today", "push the plan out two weeks", "push everything to next week", "move today\'s tasks to tomorrow", or any reschedule touching more than a couple of tasks: never loop update_schedule_item for a bulk date change. Scope (exactly one): goal_search/goal_id (every open task linked to that project), explicit ids, or all:true (every open task on the schedule — combine with date_from/date_to to bound it, e.g. today-only). Amount: shift_days for RELATIVE pushes ("push out a week" = shift_days:7 — the right choice whenever the user says "by N days/weeks"), OR anchor_date for absolute starts ("start this today") — the earliest open dated task lands on that date and every other task moves by the same number of days. To put EVERY task in scope on one day (no spacing kept) add collapse:true — "move the overdue to today" / "push to today" is exactly all:true, date_to:"yesterday", anchor_date:"today", collapse:true (list_schedule rows carry date + overdue, so you can see which are past); with overdue tasks in scope an anchor can move everything much further than the user pictured, so never use anchor_date for a relative push. The user approves the exact count, shift, and resulting first/last dates in a dialog before anything is written.',
            parameters: { type: 'object', properties: {
                goal_search: { type: 'string', description: 'Project title — shifts all its open linked tasks' },
                goal_id: { type: 'string' },
                ids: { type: 'array', items: { type: 'string' }, description: 'Explicit schedule item ids instead of a project' },
                all: { type: 'boolean', description: 'Every open task on the schedule ("push everything…"). Use date_from/date_to to bound it.' },
                date_from: { type: 'string', description: 'Only shift tasks dated on/after this ("yesterday" | "today" | "tomorrow" | YYYY-MM-DD)' },
                date_to: { type: 'string', description: 'Only shift tasks dated on/before this ("yesterday" | "today" | "tomorrow" | YYYY-MM-DD) — "yesterday" = every overdue task' },
                shift_days: { type: 'number', description: 'Days to move every task (negative = earlier)' },
                anchor_date: { type: 'string', description: '"today" | "tomorrow" | YYYY-MM-DD — where the earliest open task should land (with collapse:true, where EVERY task lands)' },
                collapse: { type: 'boolean', description: 'With anchor_date: put every dated task in scope ON the anchor date instead of keeping their spacing ("move the overdue to today")' },
                preserve_weekday_cadence: { type: 'boolean', description: 'Round the shift up to whole weeks so every task keeps its weekday (Mon stays Mon); with anchor_date the first task lands on or after the anchor' },
                only_future: { type: 'boolean', description: 'Leave tasks dated before today untouched' }
            }}
        }},
        { type: 'function', function: {
            name: 'create_schedule_item',
            description: 'Create a task/event. Only title is required; an untimed task is a plain to-do. Don\'t prompt for other fields.',
            parameters: { type: 'object', properties: {
                title: { type: 'string' },
                description: { type: 'string', description: 'Notes / details for the task (optional)' },
                startTime: { type: 'string', description: 'HH:MM (24h). Optional — omit for an untimed to-do.' },
                endTime: { type: 'string', description: 'HH:MM (24h)' },
                scheduledDate: { type: 'string', description: 'YYYY-MM-DD, or "today"/"tomorrow". Default: today.' },
                repeat: { type: 'string', enum: ['once', 'daily', 'weekdays', 'weekly'] },
                goalTitle: { type: 'string', description: 'Existing project title to link (optional)' }
            }, required: ['title'] }
        }},
        { type: 'function', function: {
            name: 'create_note',
            description: 'Create a note.',
            parameters: { type: 'object', properties: {
                title: { type: 'string' },
                content: { type: 'string' },
                tags: { type: 'array', items: { type: 'string' } }
            }, required: ['title'] }
        }},
        // ACTION
        { type: 'function', function: {
            name: 'complete_task',
            description: 'Mark a scheduled task completed for today — the WHOLE task. If the task covers multiple things and the user finished only some of them, do NOT call this: tell them what the task still includes and ask whether to complete it anyway or keep it open for the rest. Find by search or id. Pass abandon:true to instead mark it abandoned (deliberately not done — resolves the task like completing, the user will not work on it anymore).',
            parameters: { type: 'object', properties: {
                search: { type: 'string' },
                id: { type: 'string' },
                abandon: { type: 'boolean' }
            }, required: ['search'] }
        }},
        { type: 'function', function: {
            name: 'delete_schedule_item',
            description: 'Permanently delete a scheduled task/event. search ≥3 chars and unique, else returns candidates.',
            parameters: { type: 'object', properties: {
                search: { type: 'string' },
                id: { type: 'string' }
            }}
        }},


        // EMAIL (Gmail via connected accounts)
        { type: 'function', function: {
            name: 'list_emails',
            description: 'Search/list LOCALLY SYNCED emails. query matches words in any order across sender/subject/preview and stored message bodies. The result\'s `coverage` says how far back local mail goes per account — mail older than that is NOT searched. If the user\'s request may need older mail, confirm the timeframe with them, then call sync_older_emails to extend coverage first. Use get_email for one full message.',
            parameters: { type: 'object', properties: {
                folder: { type: 'string', enum: ['inbox', 'unread', 'priority', 'archive', 'trash', 'sent', 'all'] },
                account: { type: 'string', description: 'Email address; default: all profile accounts' },
                from: { type: 'string', description: 'Sender substring (case-insensitive)' },
                query: { type: 'string', description: 'Words in any order; "quoted phrase" for exact' },
                after: { type: 'string', description: 'Only mail on/after this date (YYYY-MM-DD)' },
                before: { type: 'string', description: 'Only mail before this date (YYYY-MM-DD)' },
                limit: { type: 'number', description: 'Default 20, max 100' }
            }}
        }},
        { type: 'function', function: {
            name: 'scan_emails',
            description: 'Bulk-extract structured data from MANY locally synced emails in one call: filters mail like list_emails, runs an AI read of each matching email, and returns one table of rows. THE tool for "review/summarize all X emails" jobs (trade histories, receipts, timelines) — never loop get_email for that. Each matched email costs one AI call (a scan of 50 takes minutes), so narrow the filter with from/query/after/before. Check coverage and confirm the timeframe with the user first; sync_older_emails extends coverage.',
            parameters: { type: 'object', properties: {
                instruction: { type: 'string', description: 'What to extract from each email, e.g. "Extract NVDA stock trades; ignore option trades"' },
                fields: { type: 'array', items: { type: 'string' }, description: 'Column names for each row, e.g. ["action","shares","price_per_share","total"]' },
                from: { type: 'string', description: 'Sender substring filter (strongly recommended)' },
                query: { type: 'string', description: 'Search words (any order; stored bodies included)' },
                folder: { type: 'string', enum: ['inbox', 'unread', 'priority', 'archive', 'trash', 'sent', 'all'], description: 'Default: all' },
                account: { type: 'string' },
                after: { type: 'string', description: 'Only mail on/after this date (YYYY-MM-DD)' },
                before: { type: 'string', description: 'Only mail before this date (YYYY-MM-DD)' },
                limit: { type: 'number', description: 'Max emails to scan (newest first). Default 50, max 200.' }
            }, required: ['instruction', 'fields'] }
        }},
        { type: 'function', function: {
            name: 'sync_older_emails',
            description: 'Download older mail history from Gmail\'s servers into the local store, going back to until_date, so email tools can see it. IMPORTANT: ask the user to confirm the timeframe BEFORE calling this — it can pull thousands of messages. Stops early at a per-call cap; call again with the same until_date to continue.',
            parameters: { type: 'object', properties: {
                until_date: { type: 'string', description: 'Fetch history back to this date (YYYY-MM-DD)' },
                account: { type: 'string', description: 'One account; default: all connected accounts' }
            }, required: ['until_date'] }
        }},
        { type: 'function', function: {
            name: 'get_email',
            description: 'Get full contents of one email by id (from list_emails). Returns up to ~5000 chars of body; pass offset to continue a truncated body. When the current model can view images, the email\'s pictures (inline images and image attachments) are attached to the result for you to read directly — many emails carry their real content in a picture. Also lists any other ATTACHMENTS (PDF, xlsx, docx…) — their contents are not included, use read_email_attachment for those.',
            parameters: { type: 'object', properties: {
                id: { type: 'string' },
                offset: { type: 'number', description: 'Character offset into the body to continue reading a long email (from the previous result\'s offset + shown length).' },
                images: { type: 'boolean', description: 'Default true: attach the email\'s images when the model can view them. Pass false to skip them.' }
            }, required: ['id'] }
        }},
        { type: 'function', function: {
            name: 'read_email_attachment',
            description: 'Read a file attached to an email — PDFs (including scanned ones, read by OCR on this Mac), Excel and Word documents, plain text, and images (png/jpeg/webp/gif, shown to you when the model has vision). Use whenever the answer depends on what an attachment says: an invoice amount or due date, a statement total, the terms in a contract. Get the id and attachmentId from get_email first. NEVER guess or infer a figure or date that lives in an attachment you have not read — say you could not read it instead.',
            parameters: { type: 'object', properties: {
                id: { type: 'string', description: 'The email id (from list_emails / get_email)' },
                attachmentId: { type: 'string', description: 'From get_email\'s attachments list. Omit only when the email has exactly one attachment.' },
                filename: { type: 'string', description: 'Alternative to attachmentId — the attachment\'s filename' }
            }, required: ['id'] }
        }},
        { type: 'function', function: {
            name: 'list_email_analyses',
            description: 'List LLM-extracted action items from incoming emails. Best for "what do I need to do from email".',
            parameters: { type: 'object', properties: {
                unread_only: { type: 'boolean', description: 'Default: true' },
                limit: { type: 'number', description: 'Default 20' }
            }}
        }},
        { type: 'function', function: {
            name: 'mark_email_read',
            description: 'Mark email read or unread.',
            parameters: { type: 'object', properties: {
                id: { type: 'string' },
                read: { type: 'boolean', description: 'Default: true' }
            }, required: ['id'] }
        }},
        { type: 'function', function: {
            name: 'archive_email',
            description: 'Archive an email.',
            parameters: { type: 'object', properties: {
                id: { type: 'string' }
            }, required: ['id'] }
        }},
        { type: 'function', function: {
            name: 'trash_email',
            description: 'Move an email to Gmail Trash.',
            parameters: { type: 'object', properties: {
                id: { type: 'string' }
            }, required: ['id'] }
        }},
        { type: 'function', function: {
            name: 'send_email',
            description: 'Send an email from a connected Gmail account. For replies, pass replyToId and the recipient + threading are inferred.',
            parameters: { type: 'object', properties: {
                to: { type: 'string', description: 'Comma-separated; required unless replyToId is set' },
                subject: { type: 'string' },
                body: { type: 'string', description: 'Plain text; HTML-escaped, newlines become <br>' },
                cc: { type: 'string' },
                bcc: { type: 'string' },
                account: { type: 'string' },
                replyToId: { type: 'string' }
            }, required: ['body'] }
        }},
        { type: 'function', function: {
            name: 'mark_analysis_read',
            description: 'Mark an email action-item analysis read/unread (separate from Gmail unread).',
            parameters: { type: 'object', properties: {
                emailId: { type: 'string' },
                read: { type: 'boolean', description: 'Default: true' }
            }, required: ['emailId'] }
        }},

        // CALENDAR (Google Calendar via connected accounts)
        { type: 'function', function: {
            name: 'list_calendar_events',
            description: 'List Google Calendar events across connected accounts (locally synced).',
            parameters: { type: 'object', properties: {
                from: { type: 'string', description: 'YYYY-MM-DD or "today"/"tomorrow". Default: today.' },
                to: { type: 'string', description: 'Inclusive end. Default: same as from.' },
                query: { type: 'string', description: 'Substring filter against summary/location/description' },
                limit: { type: 'number', description: 'Default 50' }
            }}
        }},
        { type: 'function', function: {
            name: 'create_calendar_event',
            description: 'Create a Google Calendar event. Use naive local "YYYY-MM-DDTHH:MM:SS" (no Z/offset); tool attaches user timezone. For all-day: all_day=true, pass YYYY-MM-DD.',
            parameters: { type: 'object', properties: {
                summary: { type: 'string' },
                start: { type: 'string', description: '"YYYY-MM-DDTHH:MM:SS", or "YYYY-MM-DD" if all_day' },
                end: { type: 'string', description: 'Same format as start. Default: start + 1h.' },
                all_day: { type: 'boolean' },
                location: { type: 'string' },
                description: { type: 'string' },
                attendees: { type: 'array', items: { type: 'string' } },
                account: { type: 'string' }
            }, required: ['summary', 'start'] }
        }},
        { type: 'function', function: {
            name: 'update_calendar_event',
            description: 'Update a Google Calendar event. Only passed fields change.',
            parameters: { type: 'object', properties: {
                id: { type: 'string' },
                summary: { type: 'string' },
                start: { type: 'string', description: 'Naive local "YYYY-MM-DDTHH:MM:SS"' },
                end: { type: 'string' },
                all_day: { type: 'boolean' },
                location: { type: 'string' },
                description: { type: 'string' }
            }, required: ['id'] }
        }},
        { type: 'function', function: {
            name: 'delete_calendar_event',
            description: 'Delete a Google Calendar event. search ≥3 chars and unique, or pass id. For recurring: mode="single" (default) or "all".',
            parameters: { type: 'object', properties: {
                search: { type: 'string' },
                id: { type: 'string' },
                from: { type: 'string', description: 'Search window start. Default: today.' },
                to: { type: 'string', description: 'Search window end. Default: today + 30 days.' },
                mode: { type: 'string', enum: ['single', 'all'] }
            }}
        }},
        { type: 'function', function: {
            name: 'update_note',
            description: 'Update a note. Find by search or id. `content` REPLACES the whole note body and is markdown — the same dialect get_note returns. To edit: take get_note\'s content, change ONLY what the user asked, and pass everything else back UNCHANGED, keeping every heading (#), list, **bold** and link that was already there — returning plain paragraphs destroys the user\'s formatting. For pure additions use `append` instead; it leaves the existing body untouched.',
            parameters: { type: 'object', properties: {
                search: { type: 'string' },
                id: { type: 'string' },
                new_title: { type: 'string' },
                content: { type: 'string', description: 'Replaces existing content. Markdown; preserve the formatting get_note returned.' },
                append: { type: 'string', description: 'Appends to existing content (markdown) without touching what is there' },
                tags: { type: 'array', items: { type: 'string' } }
            }, required: ['search'] }
        }},
        { type: 'function', function: {
            name: 'delete_note',
            description: 'Permanently delete a note (the user is asked to approve). Find by search (≥3 chars, must resolve to exactly one note — candidates are returned otherwise) or id. Refuses armed routines — those go through delete_routine.',
            parameters: { type: 'object', properties: {
                search: { type: 'string' },
                id: { type: 'string' }
            }}
        }},
        { type: 'function', function: {
            name: 'link_items',
            description: 'Link an existing task to a project.',
            parameters: { type: 'object', properties: {
                type: { type: 'string', enum: ['task_to_goal'] },
                itemSearch: { type: 'string' },
                targetSearch: { type: 'string' }
            }, required: ['type', 'itemSearch', 'targetSearch'] }
        }},
        { type: 'function', function: {
            name: 'daily_briefing',
            description: 'Get today\'s schedule, active projects, recent journal, overdue tasks.',
            parameters: { type: 'object', properties: {} }
        }},

        // MEMORY — persistent notes about the user across chats
        { type: 'function', function: {
            // When-to-use lives in the MEMORY domain guidance, which ships
            // whenever this tool does — not duplicated here.
            name: 'save_memory',
            description: 'Save a lasting fact or preference about the user for future chats. Dedupe automatic; saving a new value under an existing title updates that fact (the old value is kept as history).',
            parameters: { type: 'object', properties: {
                type: { type: 'string', enum: ['preference', 'fact', 'context', 'correction'] },
                title: { type: 'string', description: 'Short label (optional; derived from body if omitted). Reuse the existing title when a fact CHANGED — that supersedes the old value.' },
                body: { type: 'string', description: 'The memory content, first-person or third-person — stored verbatim.' },
                entity: { type: 'string', description: 'The person, place, or topic this is about (optional).' }
            }, required: ['type', 'body'] }
        }},
        { type: 'function', function: {
            name: 'list_memories',
            description: 'List stored memories. Optionally filter by type.',
            parameters: { type: 'object', properties: {
                type: { type: 'string', enum: ['preference', 'fact', 'context', 'correction'] }
            }}
        }},
        { type: 'function', function: {
            name: 'search_memories',
            description: 'Keyword search across stored memories and memory pages.',
            parameters: { type: 'object', properties: {
                query: { type: 'string' }
            }, required: ['query'] }
        }},
        { type: 'function', function: {
            name: 'update_memory',
            description: 'Fix wrong text on a memory page, in place, when the user explicitly corrects a stored fact ("actually it\'s X, not Y", "update your memory"). Call recall_memory first, then copy the wrong text verbatim into `find`. The page is corrected immediately — do not just save a new memory alongside the wrong one.',
            parameters: { type: 'object', properties: {
                page: { type: 'string', description: 'Page title or key from the memory page index' },
                find: { type: 'string', description: 'The exact wrong text as it appears on the page — copy verbatim from recall_memory' },
                replace: { type: 'string', description: 'The corrected text. Empty string removes the wrong text.' },
                summary: { type: 'string', description: 'New one-line summary — only when the current summary also states the wrong fact' }
            }, required: ['page', 'find', 'replace'] }
        }},
        { type: 'function', function: {
            name: 'delete_memory',
            description: 'Delete a memory by id. Only use when the user explicitly asks to forget something.',
            parameters: { type: 'object', properties: {
                id: { type: 'string' }
            }, required: ['id'] }
        }},
        // recall_memory is deliberately NOT in the memory domain group (see
        // _toolGroups): personal questions ("what's my wife's name?") carry no
        // memory keyword, so the tool must be present on every turn for the
        // briefing's page index to be actionable.
        { type: 'function', function: {
            name: 'recall_memory',
            description: 'Read one of the user\'s memory pages by title (see the memory page index in your context). Use before answering questions about the user\'s preferences, people, history, or tastes.',
            parameters: { type: 'object', properties: {
                page: { type: 'string', description: 'Page title or key from the memory page index' }
            }, required: ['page'] }
        }},
        { type: 'function', function: {
            name: 'list_memory_pages',
            description: 'List the user\'s memory pages: title, one-line summary, last updated. Fresh — includes pages created after this chat started.',
            parameters: { type: 'object', properties: {} }
        }},

        // LIBRARY tools (search_library / read_library_doc /
        // draft_in_style) are registered by the Reader package:
        // js/apps/reader/library-tools.js.

        // DECISIONS — dated instructions pinned to ONE record (task, goal,
        // note, routine, strategy, account). Unlike memories (facts about
        // the user), a decision rides along automatically whenever that
        // record is read. When-to-use lives in the stable prompt's RECORD
        // DECISIONS rule — these are core tools, present every turn.
        { type: 'function', function: {
            name: 'save_decision',
            description: 'Save a decision the user settled about one specific record — a plan, constraint, or standing instruction that does not fit the record\'s own fields. The user is asked to approve each save. Use the record\'s id from a tool result (strategies and accounts also accept a name). When a decision CHANGES, save with the SAME title — the old one is kept as superseded history.',
            parameters: { type: 'object', properties: {
                type: { type: 'string', enum: ['task', 'goal', 'note', 'routine', 'strategy', 'account'] },
                id: { type: 'string', description: 'The record\'s id from a tool result' },
                name: { type: 'string', description: 'Strategy or account name (alternative to id for those two types)' },
                title: { type: 'string', description: 'Short label for the decision — the handle a later save reuses to supersede it, e.g. "Excess cash deployment"' },
                decision: { type: 'string', description: 'The decision itself, with the concrete details (amounts, dates, splits) — stored verbatim, shown back to you on every read of this record.' }
            }, required: ['type', 'title', 'decision'] }
        }},
        { type: 'function', function: {
            name: 'list_decisions',
            description: 'List the saved decisions on one record, newest first. Reads of a record already attach its active decisions — call this for the full list or for superseded history.',
            parameters: { type: 'object', properties: {
                type: { type: 'string', enum: ['task', 'goal', 'note', 'routine', 'strategy', 'account'] },
                id: { type: 'string' },
                name: { type: 'string', description: 'Strategy or account name (alternative to id)' },
                include_superseded: { type: 'boolean', description: 'Also return decisions that were later replaced' }
            }, required: ['type'] }
        }},
        { type: 'function', function: {
            name: 'delete_decision',
            description: 'Delete a saved decision by id (from list_decisions or a decisions field on a read result). Only when the user asks to remove it — a CHANGED decision should instead be saved again under the same title.',
            parameters: { type: 'object', properties: {
                id: { type: 'string' }
            }, required: ['id'] }
        }},

        // ROUTINES — recurring prompts run in the background on the
        // local model (PromptFeed); results post to the Home feed. The
        // conversational front door for the same prompt-notes the Feed's
        // "Manage prompts" UI edits.
        { type: 'function', function: {
            name: 'start_routine_interview',
            description: 'Begin the guided intake that turns a conversation into a routine — something Anjadhe does on its own. Returns the fixed agenda (what it should do, when it runs, answer-vs-actions, sources), the reason each topic matters, and the user\'s existing routines for context. Call this FIRST whenever the user wants help setting up a routine or automation, asks what routines can do, or wants one but hasn\'t specified the pieces — the agenda is fixed, do not improvise your own questions. When the user has already dictated a complete routine, skip this and call create_routine directly.',
            parameters: { type: 'object', properties: {} }
        }},
        { type: 'function', function: {
            name: 'create_routine',
            description: 'Create a ROUTINE — something Anjadhe does on its own when a trigger fires: on a schedule, when a matching email arrives, or when a new file lands in a folder. Use whenever the user wants something recurring or automatic ("every morning…", "weekly digest of…", "whenever an invoice email arrives…"). The prompt must be a complete standalone instruction with every stated preference baked in. For an email or file trigger, each matching thing fires its OWN run and the run context names it (the email\'s id, the file\'s path) — so write the prompt about "the email/file that triggered this run" and NEVER as a search ("search the mailbox for invoices…" re-does every earlier match\'s work each fire). Two run modes: "digest" (default) answers it read-only and posts the answer to the Home feed; "task" runs a multi-step task that may CHANGE things, pausing for permission when a step needs it — its run log stays on the routine\'s page (Run history), never the feed. Choose "task" only when the request needs actions taken, not just an answer written.',
            parameters: { type: 'object', properties: {
                title: { type: 'string', description: 'Short feed label, e.g. "Staff+ job digest"' },
                prompt: { type: 'string', description: 'The full instruction to run each time, self-contained — include all the user\'s stated preferences and criteria.' },
                trigger: { type: 'object', description: 'What starts it. One of: {"type":"time","interval":"hourly|6h|daily|weekdays|weekly","time":"HH:MM"} (weekdays = Mon–Fri; "every morning" → "08:00"; omit time for hourly/6h) · {"type":"email","from":"...","subject":"...","contains":"..."} (case-insensitive substring match on the sender, the subject line, and the whole message text respectively; at least one. Use `contains` for "an email WITH an invoice / a receipt in it" — subject-only would miss a mail whose subject never says the word) · {"type":"file","folder":"~/...","pattern":"*.pdf"}' },
                runMode: { type: 'string', enum: ['digest', 'task'], description: 'digest = write me an answer (default); task = take actions' },
                web: { type: 'boolean', description: 'Allow web search during runs — needed for anything based on outside data (jobs, news, prices). Digest mode only.' },
                useContext: { type: 'boolean', description: 'Run with the user\'s personal context (memory, projects, schedule). Digest mode only.' },
                voice: { type: 'string', description: 'Write the posts in one of the user\'s Writing Voices, by name (e.g. "My voice"). Digest mode only; omit for the assistant\'s own voice (the default).' }
            }, required: ['prompt', 'trigger'] }
        }},
        { type: 'function', function: {
            name: 'list_routines',
            description: 'List the user\'s routines — what Anjadhe runs on its own (the Routines page; a digest posts to the Home feed, an action run keeps its log on the routine\'s Run history): id, title, prompt snippet, what triggers it, run mode, last run. Long prompt text is snipped — call get_note with the routine\'s id when the answer depends on the full wording. Call this FIRST for any question about a routine\'s schedule, timing, or behavior — e.g. "why did my market review run at the wrong time".',
            parameters: { type: 'object', properties: {} }
        }},
        { type: 'function', function: {
            name: 'update_routine',
            description: 'Change a routine\'s title, prompt text, or schedule. Resolve id with list_routines first. Omitted fields stay unchanged.',
            parameters: { type: 'object', properties: {
                id: { type: 'string' },
                title: { type: 'string' },
                prompt: { type: 'string', description: 'Replacement instruction (full text, not a diff)' },
                interval: { type: 'string', enum: ['hourly', '6h', 'daily', 'weekdays', 'weekly'], description: 'weekdays = Mon–Fri only' },
                time: { type: 'string', description: 'HH:MM 24h run time for daily/weekdays/weekly; pass "" to clear' },
                web: { type: 'boolean' },
                useContext: { type: 'boolean' },
                voice: { type: 'string', description: 'A Writing Voice name for the posts; pass "" for the assistant\'s own voice' }
            }, required: ['id'] }
        }},
        { type: 'function', function: {
            name: 'delete_routine',
            description: 'Delete a routine and stop its runs (past feed posts stay). Resolve id with list_routines first.',
            parameters: { type: 'object', properties: {
                id: { type: 'string' }
            }, required: ['id'] }
        }},

        // BUILD — read-only doors onto the user's self-built apps
        // (~/Anjadhe/apps/). The Maker artifact engine was removed
        // 2026-08-30; apps are built with the user's own coding agent.
        { type: 'function', function: {
            name: 'list_creations',
            description: 'List the user\'s built apps with their ids.',
            parameters: { type: 'object', properties: {} }
        }},
        { type: 'function', function: {
            name: 'read_creation',
            description: 'Read the CURRENT files of a user-built app (manifest + spec/code). Use when the user asks about the app or you need exact field/component names. Large files return in pages; pass offset to continue.',
            parameters: { type: 'object', properties: {
                appId: { type: 'string', description: 'App id from list_creations' },
                file: { type: 'string', description: 'Optional: read one file only (e.g. "app.js", "app.spec.json")' },
                offset: { type: 'number', description: 'Character offset to continue a truncated file from' }
            } }
        }},

        // FILES + SHELL — act on the Mac's filesystem (docs/COWORK_AGENT.md
        // C3). Paths must be absolute or ~-based; ~/Anjadhe is always
        // allowed, anything else prompts the user for permission the first
        // time (a "not permitted" result means retry once — the user will
        // be asked).
        { type: 'function', function: {
            name: 'fs_list',
            description: 'List a folder on the user\'s Mac. ALWAYS pass `pattern` when hunting a file type (e.g. "*.pdf") — long unfiltered listings get shortened and files can be missed. Returns total/matched counts; if truncated, call again with a pattern.',
            parameters: { type: 'object', properties: {
                path: { type: 'string', description: 'Folder path, absolute or ~-based (e.g. ~/Downloads)' },
                pattern: { type: 'string', description: 'Name filter: a glob like "*.pdf" or a word like "invoice". Omit to list everything.' }
            }, required: ['path'] }
        }},
        { type: 'function', function: {
            name: 'fs_read',
            description: 'Read a file on the user\'s Mac: plain text, and also PDF / xlsx / docx (extracted to text, scanned PDFs OCR\'d locally) and images (shown to you when the model has vision). Returns up to 6000 chars; pass offset to continue — page through a long document rather than guessing from its filename.',
            parameters: { type: 'object', properties: {
                path: { type: 'string', description: 'File path, absolute or ~-based' },
                offset: { type: 'number', description: 'Character offset to continue from (default 0)' }
            }, required: ['path'] }
        }},
        { type: 'function', function: {
            name: 'fs_search',
            description: 'Find files/folders by name under a folder (recursive, case-insensitive substring).',
            parameters: { type: 'object', properties: {
                path: { type: 'string', description: 'Folder to search under, absolute or ~-based' },
                query: { type: 'string', description: 'Name fragment to match' }
            }, required: ['path', 'query'] }
        }},
        { type: 'function', function: {
            name: 'fs_write',
            description: 'Write a TEXT FILE on the user\'s Mac (creates parent folders; overwrites). Max 5MB. NOT for folders — use fs_mkdir to create a folder.',
            parameters: { type: 'object', properties: {
                path: { type: 'string', description: 'File path, absolute or ~-based' },
                content: { type: 'string', description: 'Full file content' }
            }, required: ['path', 'content'] }
        }},
        { type: 'function', function: {
            name: 'fs_mkdir',
            description: 'Create a folder (and any missing parents) on the user\'s Mac. Use this BEFORE moving files into a new folder.',
            parameters: { type: 'object', properties: {
                path: { type: 'string', description: 'Folder path, absolute or ~-based' }
            }, required: ['path'] }
        }},
        { type: 'function', function: {
            name: 'fs_trash',
            description: 'Move a file or folder to the macOS Trash (recoverable). The only way to delete — there is no permanent delete.',
            parameters: { type: 'object', properties: {
                path: { type: 'string', description: 'Path to trash, absolute or ~-based' }
            }, required: ['path'] }
        }},
        { type: 'function', function: {
            name: 'fs_move',
            description: 'Move or rename a file/folder. Refuses to overwrite an existing destination.',
            parameters: { type: 'object', properties: {
                from: { type: 'string', description: 'Current path, absolute or ~-based' },
                to: { type: 'string', description: 'New path, absolute or ~-based' }
            }, required: ['from', 'to'] }
        }},
        { type: 'function', function: {
            name: 'start_task',
            description: 'Start a MULTI-STEP task: use when the request needs several different actions done in sequence (organize, gather + create, cross-app work, or multi-item web research — "find ten X and their contact info" fans out over many searches). Produces a step plan the user approves; the task then runs itself and reports back. Do NOT use for a single action — just do it. If a saved recipe (see your briefing) already matches the request, prefer run_recipe.',
            parameters: { type: 'object', properties: {
                goal: { type: 'string', description: 'The complete outcome the user wants, restated fully. The recent conversation is attached to the task automatically, so the goal may reference lists or data already in this chat without restating them.' }
            }, required: ['goal'] }
        }},
        { type: 'function', function: {
            name: 'run_recipe',
            description: 'Replay a SAVED RECIPE — a verified tool procedure from a past successful task (your briefing lists them under "Saved recipes"). Far more reliable than re-planning: the recorded steps run in order with your parameters filled in, each under the normal permission gate. If a step fails, the result tells you exactly what completed, what failed, and what remains — fix that step with your normal tools and finish the remainder; do not restart the recipe.',
            parameters: { type: 'object', properties: {
                name: { type: 'string', description: 'The recipe name, exactly as listed in the briefing' },
                params: { type: 'object', description: 'Values for the recipe\'s parameters, e.g. {"ticker": "NVDA"}. Omit if the recipe has none.' }
            }, required: ['name'] }
        }},
        { type: 'function', function: {
            name: 'run_command',
            description: 'Run a shell command on the user\'s Mac (output truncated). Simple read-only commands (ls, git status…) run directly; anything else needs the user\'s approval. Never sudo.',
            parameters: { type: 'object', properties: {
                command: { type: 'string', description: 'The exact command' },
                cwd: { type: 'string', description: 'Working directory (default: home)' },
                timeoutSec: { type: 'number', description: 'Seconds before the command is killed (default 30, max 300 — raise it for builds/installs)' }
            }, required: ['command'] }
        }},
        { type: 'function', function: {
            name: 'run_applescript',
            description: 'Control other Mac apps with AppleScript — open/quit apps, Finder, Safari, Notes, Music, System Events UI automation. Returns the script\'s result text. Every script needs the user\'s approval, and macOS asks its own one-time consent per controlled app. For shell commands use run_command instead ("do shell script" is blocked here).',
            parameters: { type: 'object', properties: {
                script: { type: 'string', description: 'The complete AppleScript source' }
            }, required: ['script'] }
        }},
        { type: 'function', function: {
            name: 'list_shortcuts',
            description: 'List the names of the Apple Shortcuts on this Mac (the user\'s own automations from the Shortcuts app). Use before run_shortcut when unsure of the exact name.',
            parameters: { type: 'object', properties: {} }
        }},
        { type: 'function', function: {
            name: 'run_shortcut',
            description: 'Run one of the user\'s Apple Shortcuts by its exact name (see list_shortcuts). Shortcuts are automations the user built themselves — prefer one over writing AppleScript when it already does the job. Each shortcut needs the user\'s approval the first time.',
            parameters: { type: 'object', properties: {
                name: { type: 'string', description: 'The exact shortcut name' }
            }, required: ['name'] }
        }},
        { type: 'function', function: {
            name: 'process_start',
            description: 'Start a LONG-RUNNING command in the background (dev server, watch build, big download) and return a processId immediately — the command keeps running while you do other work. Same approval rules as run_command. For anything that finishes in seconds, use run_command instead.',
            parameters: { type: 'object', properties: {
                command: { type: 'string', description: 'The exact command' },
                cwd: { type: 'string', description: 'Working directory (default: home)' }
            }, required: ['command'] }
        }},
        { type: 'function', function: {
            name: 'process_status',
            description: 'Check a background process: whether it is still running, and its output since your last check. Do other work between polls — do not poll in a tight loop.',
            parameters: { type: 'object', properties: {
                processId: { type: 'string', description: 'The id from process_start' }
            }, required: ['processId'] }
        }},
        { type: 'function', function: {
            name: 'process_stop',
            description: 'Stop a background process (graceful stop, force-kill after 5s).',
            parameters: { type: 'object', properties: {
                processId: { type: 'string', description: 'The id from process_start' }
            }, required: ['processId'] }
        }},
        { type: 'function', function: {
            name: 'process_list',
            description: 'List the background processes started this session (running and recently exited).',
            parameters: { type: 'object', properties: {} }
        }},
    ],

    /**
     * Tool name → domain group. Tools not listed here fall into "core" and are
     * always included by definitionsFor(). Keep this in sync with definitions[].
     */
    _toolGroups: {
        // email
        list_emails: 'email', get_email: 'email', list_email_analyses: 'email',
        read_email_attachment: 'email',
        mark_email_read: 'email', archive_email: 'email', sync_older_emails: 'email',
        scan_emails: 'email',
        trash_email: 'email', send_email: 'email', mark_analysis_read: 'email',
        // calendar
        list_calendar_events: 'calendar', create_calendar_event: 'calendar',
        update_calendar_event: 'calendar', delete_calendar_event: 'calendar',
        // schedule-write (list_schedule is in core)
        create_schedule_item: 'schedule', update_schedule_item: 'schedule',
        shift_schedule_items: 'schedule',
        delete_schedule_item: 'schedule', complete_task: 'schedule',
        // portfolio: registered by its package, js/apps/portfolio/portfolio-tools.js
        // goals
        list_goals: 'goals', create_goal: 'goals', update_goal: 'goals',
        delete_goal: 'goals',
        start_goal_interview: 'goals', save_goal: 'goals', link_items: 'goals',
        // bookmarks: registered by its package, js/apps/bookmarks/bookmarks-tools.js
        // journal: registered by its package, js/apps/journal/journal-tools.js
        // wellness (health log): registered by its package, js/apps/wellness/wellness-tools.js
        // notes-write (list_notes + create_note are in core)
        update_note: 'notes', delete_note: 'notes',
        // memory
        save_memory: 'memory', list_memories: 'memory',
        search_memories: 'memory', delete_memory: 'memory',
        update_memory: 'memory', list_memory_pages: 'memory',
        // recall_memory intentionally unmapped → 'core': the briefing's memory
        // page index must be actionable on every turn, keyword or not.
        // save_decision / list_decisions / delete_decision are also unmapped →
        // 'core' for the same reason: decisions get settled in ANY domain
        // conversation (a strategy chat, a goal chat), and the `decisions`
        // field riding on read results must be actionable when it appears.
        // routines (Prompt Feed)
        start_routine_interview: 'prompts',
        create_routine: 'prompts', list_routines: 'prompts',
        update_routine: 'prompts', delete_routine: 'prompts',
        // news: registered by its package, js/apps/news/news-tools.js
        // library: registered by the Reader package, js/apps/reader/library-tools.js
        // app help (the in-app user guide — help-docs.js) and what this Mac
        // has actually set up (accounts / model / search / sync)
        get_help: 'help', get_setup_status: 'help',
        // build (user-built apps, read-only)
        list_creations: 'build', read_creation: 'build',
        // files + shell (C3; gated by the `agentfs` feature flag below)
        fs_list: 'files', fs_read: 'files', fs_search: 'files',
        fs_write: 'files', fs_mkdir: 'files', fs_trash: 'files', fs_move: 'files',
        run_command: 'shell', run_applescript: 'shell',
        list_shortcuts: 'shell', run_shortcut: 'shell',
        process_start: 'shell', process_status: 'shell',
        process_stop: 'shell', process_list: 'shell',
        // Core (anything not mapped): search_all, web_search, read_url,
        // list_schedule, daily_briefing, create_note, list_notes, get_note.
        // get_note is core because list_notes/search_all are: finding a note
        // and being unable to read it is a dead end. These ship
        // every turn. read_url is core deliberately: it pairs with web_search
        // (also core) for the search→read two-hop, and a pasted URL carries
        // no keyword to scope on.
    },

    /**
     * Classify a user message into the domain groups whose tools should be
     * included this turn. Core tools are always shipped, so messages that
     * don't match any domain still have enough to answer generic questions
     * (list schedule, search, web, take a note).
     *
     * Word boundaries are important here — plain `/note/` would match
     * "notice", plain `/set/` would match "settings". We also match on the
     * original-case text for ticker regex (which needs ALL-CAPS).
     */
    _domainsForMessage(text) {
        const out = new Set();
        if (!text || typeof text !== 'string') return out;
        const s = text.toLowerCase();
        if (/\b(emails?|inbox|mail|unsubscribe|repl(y|ies|ying)|gmail)\b/.test(s) || /@\w+\.\w+/.test(s)) out.add('email');
        if (/\b(calendars?|meetings?|appointments?|events?|invites?)\b/.test(s)) out.add('calendar');
        // Beyond the task nouns: the consumer phrasings that mean "my
        // schedule" without saying it (journey-factory finding 2026-08-28 —
        // "put X on my list for Sunday" and "whats tomorrow look like"
        // shipped NO schedule tools and the teacher said so out loud).
        // "my list"/"my plate"/"my day|week" + day-shaped questions.
        if (/\b(tasks?|todos?|to-dos?|remind\w*|dues?|deadlines?|overdue)\b/.test(s) || /\bschedul\w+/.test(s)
            || /\b(on|off|to|from)\s+(my|the)\s+(list|plate)\b/.test(s)
            || /\bmy\s+(day|week|morning|afternoon|evening)\b/.test(s)
            || /\b(what'?s?|hows?|how's|what\s+does)\s+(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|my\s+\w+day)\b/.test(s)) out.add('schedule');
        // "plan" alone is far too common (meal plan, plan my day), so the
        // strategy phrasings are matched as phrases, not as a bare word.
        // "update the Padma-Robinhood account with this transaction" carries
        // no market noun, so account/transaction/broker words and the user's
        // own account names all gate the group (2026-07-31 miss: the agent
        // had no portfolio tools and tried to log a trade in notes).
        // portfolio: vocabulary (incl. the user's own account names) registered by its package
        if (/\b(projects?|goals?|focus\s+areas?|priorit\w+)\b/.test(s)) {
            out.add('goals');
            // Goal tasks ARE schedule items, and the goals guidance points at
            // create_schedule_item / shift_schedule_items — prose without the
            // tools makes the model claim it can't do what the prompt just
            // described ("start this goal today" matched goals alone and
            // shipped no schedule-write tools).
            out.add('schedule');
        }
        // bookmarks: vocabulary registered by its package
        // journal vocabulary: registered by its package (registerDomain)
        // wellness: vocabulary registered by its package (AgentTools.registerDomain)
        if (/\bnotes?\b/.test(s)) out.add('notes');
        if (/\b(remember|forget|recall|memor(y|ies)|\bprefer\w*|from\s+now\s+on|keep\s+in\s+mind|correct\w*)\b/.test(s)) out.add('memory');
        // Recurring intent → routines. Bare "morning"/"weekly" words
        // are too common, so require the every/each frame or an explicit
        // recurrence/feed word.
        //
        // The word "prompt" itself ALWAYS ships the group (2026-07-30, second
        // miss of this kind): it used to require a managing verb BEFORE the
        // noun, so "my market review prompts are scheduled at wrong times" —
        // verb after noun — shipped nothing, and the model flailed through
        // schedule/notes tools instead. The feature is literally named
        // "prompts"; any mention is signal enough, and the group is only 4
        // small schemas, so over-matching is cheap.
        //
        // TRIGGER vocabulary is here for a reason (2026-08-03, C10 regression).
        // Before the merge, `create_automation` was UNGROUPED — i.e. core — so
        // it shipped every turn, and "every time I get an invoice email, make a
        // task" reached it. C10 folded that tool into `create_routine` in this
        // group, whose matcher only knew RECURRENCE words ("every morning",
        // "daily"), not TRIGGER words. Result: the one phrasing an event
        // routine is always asked in shipped no routine tools at all, and the
        // model answered "I don't have a create_routine function" while the
        // handler sat right there. A routine now has three trigger types, so
        // this matcher has to cover all three ways of asking.
        if (/\bprompts?\b/.test(s)
            || /\broutines?\b/.test(s)
            || /\bautomat\w+/.test(s)            // automation, automate, automatically
            || /\btrigger\w*/.test(s)
            || /\b(every|each)\s+(day|morning|afternoon|evening|night|week|hour|(mon|tues|wednes|thurs|fri|satur|sun)day)\b/.test(s)
            || /\b(everyday|daily|weekly|hourly|weekdays?|recurring|regularly|digest|briefings?)\b/.test(s)
            || /\bfeed\b/.test(s)
            // Event triggers: "every time an invoice arrives", "whenever a file
            // lands in Downloads", "when I get an email from my landlord".
            || /\b(every|each)\s+time\b/.test(s)
            || /\bwhenever\b/.test(s)
            || /\bwhen\s+(i|a|an|the|my|new)\b[^.?!]*\b(arrives?|lands?|comes?\s+in|shows?\s+up|appears?|is\s+received|receive|get)\b/.test(s)
            // "do it without me here" — the unattended framing, which is what
            // runMode:'task' is for.
            || /\b(unattended|by\s+itself|on\s+its\s+own|in\s+the\s+background|hands[-\s]?off|without\s+me)\b/.test(s)
            // A message naming one of the user's own prompts BY TITLE ("why
            // did my Pre-Market Review run at 4pm?") is about that prompt
            // even without any keyword above.
            || this._mentionsPromptTitle(s)) out.add('prompts');
        // news: vocabulary registered by its package
        // library vocabulary: registered by the Reader package (registerDomain)
        if (/\b(builds?|apps?|trackers?|widgets?|dashboards?|creations?)\b/.test(s)) out.add('build');
        if (/\b(files?|folders?|director(y|ies)|desktop|downloads?|documents|finder|paths?|\.\w{2,4})\b/.test(s) || /~\//.test(text)) out.add('files');
        if (/\b(shell|terminal|command( line)?|commands|run|execute|git|zsh|bash|scripts?)\b/.test(s)
            // App-control intent → run_applescript (same 'shell' group):
            // driving other Mac apps by name, or classic automation verbs.
            || /\bshortcuts?\b/.test(s)
            || /\b(applescript|automat\w+|open|launch|quit|close)\b.*\b(app|apps|application|safari|finder|music|spotify|preview|pages|keynote|numbers|xcode|chrome)\b/.test(s)
            || /\b(play|pause|skip)\b.*\b(music|song|track|playlist)\b/.test(s)) out.add('shell');
        // App-usage questions → the get_help guide and get_setup_status.
        // "how do/can I" is broad (matches generic how-tos too) but ships
        // only two small schemas, and the domain prose keeps the model from
        // calling them for non-app asks.
        if (/\b(settings?|configure|configuring|set ?up|setup|enable|disable|turn (on|off)|anjadhe|this app|the app|shortcuts?|profiles?|app lock|dark mode|onboard\w*|connect\w*)\b/.test(s)
            || /\bhow (do|can|does) (i|you|it)\b/.test(s) || /\bwhere (is|are|do|does|can)\b/.test(s)
            // Capability and first-run questions. "What can you do?" is the
            // literal prompt the setup checklist seeds (setup-assistant.js),
            // and a bare one matched nothing — the tour answer needs the
            // guide, and what to suggest trying depends on what is connected.
            || /\bwhat can (you|it|i|we|anjadhe|this)\b/.test(s)
            || /\b(get(ting)? started|first steps?|give me a tour)\b/.test(s)
            || /\bwhat should i (do|try|start with)\b/.test(s)
            // "Why can't you see my calendar?" is a setup question wearing a
            // capability question's clothes — nearly always a missing
            // account, model, or search provider, which get_setup_status
            // answers and guesswork does not.
            || /\bwhy (can'?t|cannot|can not|don'?t|doesn'?t|didn'?t) (you|it|anjadhe|this app|the app)\b/.test(s)) out.add('help');
        // User-app tool groups (see register below): each group ships when
        // the message mentions the app's name/keywords.
        for (const group of this.dynamicDomainsFor(text)) out.add(group);
        return out;
    },


    /** True when the message contains the title of any existing prompt note
     *  (case-insensitive substring; titles under 4 chars skipped as noise). */
    _mentionsPromptTitle(s) {
        try {
            if (typeof NotePrompts === 'undefined') return false;
            return NotePrompts.list().some(n => {
                const t = (n.title || '').trim().toLowerCase();
                return t.length >= 4 && s.includes(t);
            });
        } catch { return false; }
    },

    /* ----------------------------------------------------------------
     * Dynamic tool registration — user-built apps add assistant tools at
     * runtime via Anjadhe SDK `registerTool` (see docs/PLATFORM.md). The
     * built-in registry above stays static; dynamic tools are tracked in
     * _dynamicTools so they can be removed when their app reloads.
     * ---------------------------------------------------------------- */
    _dynamicTools: {},      // tool name -> { source, group, ask, describe, … } (see register)
    _dynamicDomainRes: {},  // group -> RegExp | predicate that summons it (registerDomain)
    _recordLabels: {},      // app id -> pill word for records its tools write ('Wellness')
    _readOnlyTools: new Set(),  // registered with readOnly: true
    _webRunTools: new Set(),    // registered with webRun: true (routine web runs)

    /**
     * Register a tool at runtime — the ONE door through which an app package
     * (bundled or user-built) contributes to the assistant. Everything the
     * assistant used to know about an app by name in this file lives on the
     * options instead, and each option writes into the table the rest of the
     * agent stack already reads, so no enforcement point needs a second
     * lookup (docs/PLATFORM.md "App packages").
     *
     * @param {object} definition - OpenAI-compatible: { type:'function', function:{ name, description, parameters } }
     * @param {function} handler - (args, ctx) => result | Promise<result>
     * @param {object} opts
     *   source         app id — unregisterBySource(source) removes everything below
     *   group          tool group for prompt scoping. Default `userapp:<source>`
     *                  (user-built apps). A bundled package names its own
     *                  ('wellness') so its tools ride that domain.
     *   keywords       words that activate the group (built into one \b regex)
     *   domain         a RegExp or predicate (lowercased text, raw text) => bool
     *                  that activates the group (registerDomain does this alone)
     *   ask            true → PermissionManager asks before every call
     *   destructive    MCP hint kept for compat; for a non-MCP tool it means ask
     *   describe       (args) => HTML for the consent dialog line (the app
     *                  names the record; the generic fallback names the tool)
     *   blockUntrusted true → dropped from untrusted turns (AgentService.
     *                  UNTRUSTED_BLOCKED_TOOLS — enforced in chat AND tasks)
     *   readOnly       true → may run in a parallel read batch
     *                  (AgentService._isReadOnlyTool) despite its name
     *   webRun         true → offered beside web_search in a web-grounded
     *                  routine run (PromptFeed._generateWithWeb)
     *   record         { app, key, label } → the written record's id/title
     *                  sit under result[key] ('.' = on the result itself);
     *                  drives the navigation pills (WriteLedger.RECORD_TOOLS)
     *   dataClass      cloud-privacy class of what this READ returns
     *                  (CloudPrivacy.TOOL_CLASS) — gates ambient runs
     *   With no keywords/domain and no group the tool ships every turn ('core').
     */
    register(definition, handler, opts = {}) {
        const fn = definition && definition.function;
        if (!fn || typeof fn.name !== 'string' || !fn.name || typeof handler !== 'function') {
            return { ok: false, error: 'register(definition, handler) needs a named function definition and a handler' };
        }
        if (this.handlers[fn.name]) {
            return { ok: false, error: `Tool "${fn.name}" already exists` };
        }
        const name = fn.name;
        const source = opts.source || 'dynamic';
        const group = opts.group || `userapp:${source}`;
        this.definitions.push(definition);
        this.handlers[name] = handler;
        const meta = { source, group, destructive: !!opts.destructive };
        this._dynamicTools[name] = meta;

        const words = [...new Set((opts.keywords || [])
            .map(k => String(k).trim().toLowerCase())
            .filter(Boolean)
            .map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))];
        if (opts.domain instanceof RegExp || typeof opts.domain === 'function') {
            this.registerDomain(group, opts.domain);
        } else if (words.length) {
            this.registerDomain(group, new RegExp(`\\b(${words.join('|')})\\b`));
        }
        // A named group scopes without a vocabulary of its own (the caller
        // may register the vocabulary separately); a default one without
        // keywords has nothing to scope on and ships every turn.
        this._toolGroups[name] = (opts.group || this._dynamicDomainRes[group]) ? group : 'core';

        if (typeof opts.describe === 'function') meta.describe = opts.describe;
        if ((opts.ask || opts.destructive) && typeof PermissionManager !== 'undefined') {
            PermissionManager.ASK_TOOLS.add(name); meta.ask = true;
        }
        if (opts.blockUntrusted && typeof AgentService !== 'undefined') {
            AgentService.UNTRUSTED_BLOCKED_TOOLS.add(name); meta.blockUntrusted = true;
        }
        if (opts.readOnly) { this._readOnlyTools.add(name); meta.readOnly = true; }
        if (opts.webRun) { this._webRunTools.add(name); meta.webRun = true; }
        if (opts.record && opts.record.app && typeof WriteLedger !== 'undefined') {
            WriteLedger.RECORD_TOOLS[name] = [opts.record.app, opts.record.key || '.'];
            if (opts.record.label) this._recordLabels[opts.record.app] = opts.record.label;
            meta.record = true;
        }
        if (opts.dataClass && typeof CloudPrivacy !== 'undefined') {
            CloudPrivacy.TOOL_CLASS[name] = opts.dataClass; meta.dataClass = true;
        }
        return { ok: true };
    },

    /**
     * Give a tool group its trigger vocabulary: a RegExp, or a predicate
     * (lowercased message, raw message) => boolean for vocabularies a regex
     * cannot express (the user's own account names). _domainsForMessage
     * tests every registered matcher and ships the group's tools when one
     * fires — the seam that lets a package own the words that summon it
     * instead of this file listing them.
     */
    registerDomain(group, matcher) {
        if (!group || !(matcher instanceof RegExp || typeof matcher === 'function')) return false;
        this._dynamicDomainRes[group] = matcher;
        return true;
    },

    /** Every registered group whose matcher fires for this text. Shared by
     *  chat (_domainsForMessage) and the task planner (_impliedGroups). */
    dynamicDomainsFor(text) {
        const raw = String(text || '');
        const s = raw.toLowerCase();
        const out = [];
        for (const group in this._dynamicDomainRes) {
            const m = this._dynamicDomainRes[group];
            let hit = false;
            try { hit = m instanceof RegExp ? m.test(s) : !!m(s, raw); } catch (_) {}
            if (hit) out.push(group);
        }
        return out;
    },

    /**
     * Remove every tool a given app registered — and every table row those
     * registrations wrote. Used before re-mounting an app (hot reload) so
     * registrations don't pile up.
     */
    unregisterBySource(source) {
        const names = Object.keys(this._dynamicTools)
            .filter(n => this._dynamicTools[n].source === source);
        const groups = new Set();
        for (const name of names) {
            const meta = this._dynamicTools[name];
            groups.add(meta.group);
            const idx = this.definitions.findIndex(d => d.function && d.function.name === name);
            if (idx !== -1) this.definitions.splice(idx, 1);
            delete this.handlers[name];
            delete this._toolGroups[name];
            delete this._dynamicTools[name];
            this._readOnlyTools.delete(name);
            this._webRunTools.delete(name);
            if (meta.ask && typeof PermissionManager !== 'undefined') PermissionManager.ASK_TOOLS.delete(name);
            if (meta.blockUntrusted && typeof AgentService !== 'undefined') AgentService.UNTRUSTED_BLOCKED_TOOLS.delete(name);
            if (meta.record && typeof WriteLedger !== 'undefined') delete WriteLedger.RECORD_TOOLS[name];
            if (meta.dataClass && typeof CloudPrivacy !== 'undefined') delete CloudPrivacy.TOOL_CLASS[name];
        }
        for (const g of groups) {
            if (!Object.values(this._dynamicTools).some(m => m.group === g)) delete this._dynamicDomainRes[g];
        }
        return names.length;
    },

    /**
     * Return a scoped subset of tool definitions for the current user message.
     * Always includes the core group (~6 tools: search, web, list_schedule,
     * list_notes, create_note, daily_briefing) plus any domain groups matched
     * in messageText.
     *
     * This exists to keep prompt-eval fast on local models. Sending all ~50
     * tool schemas each turn is ~7.5k prompt tokens on gemma4:e2b, which
     * dominates latency on an M1-class Mac (~150 tok/s prompt-eval). A typical
     * scoped turn ships 8–20 tools.
     *
     * Fallback: if messageText is missing/non-string, ship everything — safer
     * to be slow than to make a tool silently unavailable.
     */
    definitionsFor(messageText, extraDomains) {
        if (!messageText || typeof messageText !== 'string') return this.definitions;
        const domains = this._domainsForMessage(messageText);
        // Conversation-level scope hints: a conversation can declare always-on
        // tool domains so a feature's tools ship even before the user types a
        // matching keyword.
        if (Array.isArray(extraDomains)) {
            for (const d of extraDomains) {
                if (typeof d === 'string' && d) domains.add(d);
            }
        }
        return this.definitions.filter(d => {
            const group = this._toolGroups[d.function.name] || 'core';
            return group === 'core' || domains.has(group);
        });
    },

    /**
     * Execute a tool by name with given arguments. Always returns a Promise —
     * some handlers are async (anything that calls Gmail/Calendar IPC), and
     * we need to await them so the LLM sees the real result instead of an
     * unresolved Promise serialized as `{}`.
     *
     * `ctx` carries per-RUN facts a handler may branch on — today just
     * `untrusted` (the turn is reading hostile input; see
     * UNTRUSTED_BLOCKED_TOOLS). An explicit parameter rather than module
     * state on purpose: concurrent streams exist (a routine digest runs
     * while the user chats), so ambient flags race across awaits. A call
     * site that omits ctx defaults to trusted — every entry point that can
     * run untrusted (agent-service sendMessage, task-service steps) MUST
     * pass it.
     */
    async execute(name, args, ctx) {
        const handler = this.handlers[name];
        if (!handler) {
            return { error: `Unknown tool: ${name}` };
        }
        // Ambient runs (routines, routine-born tasks) on a brain off this
        // Mac: a read of a class the user keeps at home answers with the
        // reason, not the data (js/core/cloud-privacy.js). Chat turns never
        // set ctx.ambient and are never gated.
        if (ctx && ctx.ambient && typeof CloudPrivacy !== 'undefined') {
            const blocked = CloudPrivacy.guardTool(name, ctx);
            if (blocked) return blocked;
        }
        try {
            return await handler(args || {}, ctx || {});
        } catch (e) {
            return { error: e.message };
        }
    },

    /**
     * Find an item by fuzzy title match or exact ID
     */
    findBySearchOrId(items, search, id) {
        if (id) {
            const exact = items.find(i => i.id === id);
            if (exact) return exact;
        }
        if (search) {
            const q = search.toLowerCase();
            // Try exact title match first, then phrase substring
            const direct = items.find(i => i.title?.toLowerCase() === q) ||
                           items.find(i => i.title?.toLowerCase().includes(q));
            if (direct) return direct;
            // Word-match fallback: catches paraphrases ("movie tickets" vs
            // "book tickets for the movie") that defeat substring matching.
            return items.find(i => AgentTools.wordsMatch(i.title, q)) || null;
        }
        return null;
    },

    /**
     * Word-level match for finding items from a user's paraphrase: true when
     * the meaningful search words mostly appear in the haystack — all of
     * them, or all-but-one when the search has 3+ words, since the user's
     * phrasing ("checked friends on movie plans") rarely mirrors the item
     * title word-for-word.
     */
    _STOP_WORDS: new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'was', 'are', 'has', 'had', 'have', 'you', 'your', 'our', 'not', 'need']),
    wordsMatch(haystack, search) {
        const words = String(search || '').toLowerCase().split(/\s+/)
            .filter(w => w.length >= 3 && !AgentTools._STOP_WORDS.has(w));
        if (!words.length) return false;
        const hay = String(haystack || '').toLowerCase();
        const matched = words.filter(w => hay.includes(w)).length;
        return matched >= (words.length >= 3 ? words.length - 1 : words.length);
    },

    // Live = not resolved for good: a one-time task is resolved by any
    // completion or abandonment, ever; a repeating task always recurs, so
    // it is always live for scheduling purposes. (list_goals' open-task
    // filter answers a different question — what's left to DO today.)
    _isLiveTask(t) {
        if (t.repeat && t.repeat !== 'none') return true;
        return !t.lastCompletedDate && !isOneTimeAbandoned(t);
    },

    /**
     * ONE builder for the bulk shift: resolves the scope (a goal's live
     * linked tasks, or explicit ids), computes the day delta, and reports
     * the before/after bounds — WITHOUT writing. The shift_schedule_items
     * handler applies exactly this plan; AgentUI._describeToolAction
     * renders the SAME plan in the consent dialog, so what the user
     * approves cannot drift from what runs (the taskContextBlock rule).
     * All of it is date arithmetic on purpose — the model states intent
     * ("first task lands today"), the app computes every date; a model
     * hand-computing 36 new dates is 36 chances to get one wrong.
     */
    _shiftPlan(args = {}) {
        const sched = StorageManager.get('schedule') || {};
        const all = sched.scheduleItems || [];
        let targets = null;
        let goal = null;
        let missingIds;
        if (Array.isArray(args.ids) && args.ids.length) {
            const byId = new Map(all.map(i => [i.id, i]));
            targets = [];
            missingIds = [];
            for (const id of args.ids) {
                const it = byId.get(id);
                if (it) targets.push(it); else missingIds.push(String(id));
            }
            if (!targets.length) return { error: 'None of the given ids matched a schedule item. Get ids from list_schedule.' };
        } else if (args.goal_search || args.goal_id) {
            const goals = (StorageManager.get('goals')?.goals) || [];
            goal = AgentTools.findBySearchOrId(goals, args.goal_search, args.goal_id);
            if (!goal) return { error: `Project not found matching "${args.goal_search || args.goal_id}". Call list_goals for titles and ids.` };
            const linked = new Set(LinkManager.getLinksForApp('goals', goal.id, 'schedule').map(l => l.itemId));
            targets = all.filter(i => linked.has(i.id));
            if (!targets.length) return { error: `Project "${goal.title}" has no linked schedule items.` };
        } else if (args.all === true) {
            // "Push everything…" — the whole schedule is the scope (2026-08-28,
            // the journey factory's finding: a research-validated top phrasing
            // had no one-call path). Same live-task filter as every scope; the
            // optional date window below is what makes "just today's" sayable.
            targets = all.slice();
            if (!targets.length) return { error: 'The schedule has no items.' };
        } else {
            return { error: 'shift_schedule_items requires goal_search, goal_id, ids, or all:true.' };
        }

        const today = getDateStr(0);
        targets = targets.filter(t => AgentTools._isLiveTask(t));
        if (args.only_future) {
            targets = targets.filter(t => !t.scheduledDate || t.scheduledDate >= today);
        }
        // Optional date window, any scope. Resolved like anchor_date; a
        // window excludes undated to-dos by construction (no date to test).
        const winDate = (v) => {
            const s = String(v || '').trim().toLowerCase();
            if (!s) return null;
            if (s === 'yesterday') return getDateStr(-1);
            if (s === 'today') return today;
            if (s === 'tomorrow') return getDateStr(1);
            return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : undefined;
        };
        const from = winDate(args.date_from), to = winDate(args.date_to);
        if (from === undefined || to === undefined) {
            return { error: 'date_from/date_to must be "yesterday", "today", "tomorrow", or YYYY-MM-DD.' };
        }
        if (from || to) {
            targets = targets.filter(t => /^\d{4}-\d{2}-\d{2}$/.test(t.scheduledDate || '')
                && (!from || t.scheduledDate >= from) && (!to || t.scheduledDate <= to));
            if (!targets.length) return { error: 'No dated open tasks inside the given date window.' };
        }
        const scopeAll = args.all === true;
        const dated = targets.filter(t => /^\d{4}-\d{2}-\d{2}$/.test(t.scheduledDate || ''));
        const undatedCount = targets.length - dated.length;
        if (!dated.length) return { error: 'No dated open tasks in scope — nothing to shift. (Undated to-dos have no date to move.)' };

        const hasShift = typeof args.shift_days === 'number' && Number.isFinite(args.shift_days);
        const anchorRaw = String(args.anchor_date || '').trim().toLowerCase();
        if (!hasShift && !anchorRaw) return { error: 'Pass shift_days or anchor_date.' };
        if (hasShift && anchorRaw) return { error: 'Pass shift_days OR anchor_date, not both.' };

        let earliest = dated[0].scheduledDate, latest = dated[0].scheduledDate;
        for (const t of dated) {
            if (t.scheduledDate < earliest) earliest = t.scheduledDate;
            if (t.scheduledDate > latest) latest = t.scheduledDate;
        }

        let delta;
        let collapseTo = null;
        if (hasShift) {
            delta = Math.round(args.shift_days);
        } else {
            const anchor = anchorRaw === 'today' ? today
                : anchorRaw === 'tomorrow' ? getDateStr(1) : anchorRaw;
            if (!/^\d{4}-\d{2}-\d{2}$/.test(anchor)) {
                return { error: `anchor_date "${args.anchor_date}" is not "today", "tomorrow", or YYYY-MM-DD.` };
            }
            // collapse: every task lands ON the anchor — the Tasks page's
            // "Push to today" as a tool. No spacing to keep, so no single
            // delta; the handler moves each task by its own distance.
            if (args.collapse === true) {
                if (args.preserve_weekday_cadence) return { error: 'collapse and preserve_weekday_cadence are exclusive.' };
                collapseTo = anchor;
                const moving = dated.filter(t => t.scheduledDate !== anchor);
                if (!moving.length) return { error: `Every task in scope is already on ${anchor}. Nothing to do.` };
                return {
                    goal: goal ? { id: goal.id, title: goal.title, targetDate: goal.targetDate || null } : null,
                    scopeAll, window: (from || to) ? { from: from || null, to: to || null } : null,
                    items: moving, delta: 0, collapseTo, undatedCount,
                    ...(missingIds && missingIds.length ? { missingIds } : {}),
                    earliest, latest, firstAfter: anchor, lastAfter: anchor
                };
            }
            delta = daysBetweenISO(earliest, anchor);
        }
        // Whole weeks keep every task's weekday; round UP so an anchored
        // first task lands on or after the anchor, never in the past.
        if (args.preserve_weekday_cadence) delta = Math.ceil(delta / 7) * 7;
        if (!delta) return { error: 'Computed shift is 0 days — the earliest open task is already on the anchor date. Nothing to do.' };
        if (Math.abs(delta) > 3660) return { error: `Computed shift of ${delta} days is implausibly large — check the dates.` };

        return {
            goal: goal ? { id: goal.id, title: goal.title, targetDate: goal.targetDate || null } : null,
            scopeAll, window: (from || to) ? { from: from || null, to: to || null } : null,
            items: dated, delta, undatedCount,
            ...(missingIds && missingIds.length ? { missingIds } : {}),
            earliest, latest,
            firstAfter: addDaysISO(earliest, delta),
            lastAfter: addDaysISO(latest, delta)
        };
    },

    /**
     * Resolve which connected email account to act on for a write operation.
     * - If `provided` is given and matches a profile account → use it
     * - If `provided` is given but unknown → return candidates so the agent can retry
     * - If omitted and the profile has exactly one account → use it
     * - If omitted and the profile has multiple → return candidates so the agent must pick
     * Returns either { account: <account> } or { error, candidates? }.
     */
    resolveEmailAccount(provided) {
        if (typeof EmailApp === 'undefined') return { error: 'Inbox app not loaded.' };
        const accounts = EmailApp.getAccounts() || [];
        if (provided) {
            const target = String(provided).toLowerCase();
            const match = accounts.find(a => (a.email || '').toLowerCase() === target);
            if (match) return { account: match };
            return {
                error: `Email account "${provided}" is not connected in the active profile.`,
                candidates: accounts.map(a => a.email)
            };
        }
        if (accounts.length === 0) {
            return { error: 'No email accounts are connected in the active profile. Connect one in Settings → Connected Accounts.' };
        }
        if (accounts.length === 1) return { account: accounts[0] };
        return {
            error: 'Multiple email accounts are connected. Specify which one with the "account" parameter.',
            candidates: accounts.map(a => a.email)
        };
    },

    /**
     * Resolve which connected calendar account to act on. Same shape as resolveEmailAccount.
     */
    resolveCalendarAccount(provided) {
        if (typeof CalendarApp === 'undefined') return { error: 'Calendar app not loaded.' };
        const accounts = CalendarApp.getAccounts() || [];
        if (provided) {
            const target = String(provided).toLowerCase();
            const match = accounts.find(a => (a.email || '').toLowerCase() === target);
            if (match) return { account: match };
            return {
                error: `Calendar account "${provided}" is not connected in the active profile.`,
                candidates: accounts.map(a => a.email)
            };
        }
        if (accounts.length === 0) {
            return { error: 'No calendar accounts are connected in the active profile. Connect one in Settings → Connected Accounts.' };
        }
        if (accounts.length === 1) return { account: accounts[0] };
        return {
            error: 'Multiple calendar accounts are connected. Specify which one with the "account" parameter.',
            candidates: accounts.map(a => a.email)
        };
    },

    /**
     * Format a plain-text email body into HTML the same way EmailApp.sendCompose() does.
     */
    plainTextBodyToHtml(text) {
        return String(text || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/\n/g, '<br>');
    },

    /**
     * Parse a datetime string from the LLM into a naive ISO 8601 string
     * (no timezone suffix). Calendar handlers pair this with an explicit
     * `timeZone` field so Google Calendar interprets it in the user's local
     * zone instead of treating Z-suffixed strings as UTC and shifting the
     * wall clock by hours.
     *
     * Accepts:
     *  - "2026-04-10T18:00:00"           — already naive ISO; pass through
     *  - "2026-04-10T18:00:00Z"          — strip the Z (LLMs sometimes add it
     *                                       even when they mean local time)
     *  - "2026-04-10T18:00:00-04:00"     — strip the offset, treat as local
     *  - "2026-04-10 18:00"              — replace space with T
     *  - "2026-04-10 18:00:00"           — same
     *  - any other string Date can parse — last-resort fallback via local Date
     *
     * Returns { iso } on success or { error } if the string is unparseable.
     */
    parseAgentDateTime(input) {
        const str = String(input || '').trim();
        if (!str) return { error: 'empty' };

        // Already a naive ISO datetime — pass through verbatim
        if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(str)) {
            const iso = /:\d{2}$/.test(str.split('T')[1]) ? str : `${str}:00`;
            return { iso };
        }
        // ISO with Z or numeric offset — strip the suffix and treat as local
        const tzMatch = str.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?)(?:Z|[+-]\d{2}:?\d{2})$/);
        if (tzMatch) {
            const naive = tzMatch[1];
            const iso = /:\d{2}$/.test(naive.split('T')[1]) ? naive : `${naive}:00`;
            return { iso };
        }
        // Space-separated date and time — normalize to T form
        const spaceMatch = str.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)/);
        if (spaceMatch) {
            const time = /:\d{2}$/.test(spaceMatch[2]) ? spaceMatch[2] : `${spaceMatch[2]}:00`;
            return { iso: `${spaceMatch[1]}T${time}` };
        }
        // Last-resort: let JS Date parse it (handles "April 10, 2026 18:00" etc.)
        const d = new Date(str);
        if (isNaN(d.getTime())) return { error: `unrecognized datetime "${str}"` };
        const pad = (n) => String(n).padStart(2, '0');
        const iso = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
        return { iso };
    },



    /**
     * Refresh the UI for a given app if it's currently active
     */
    refreshApp(appName) {
        // Schedule/goal data lives behind the Actions hub now (the
        // standalone Tasks/Goals pages are retired): a change repaints
        // whichever hub tab the user is looking at.
        if (appName === 'schedule' || appName === 'goals') {
            if (appName === 'schedule') ScheduleApp.loadData(); else GoalsApp.loadGoals();
            if (AppManager.currentApp === 'actions') ActionsApp.render();
            else if (AppManager.currentApp === 'goals') GoalsPage.render();
            return;
        }
        const appMap = {
            notes: () => { NotesApp.loadNotes(); NotesApp.render(); },
            email: () => { EmailApp.loadData(); EmailApp.render?.(); },
            calendar: () => { CalendarApp.loadData(); CalendarApp.render?.(); }
        };
        if (AppManager.currentApp === appName && appMap[appName]) {
            appMap[appName]();
        }
    },

    // ── I8 idempotency for record-creating tools (docs/TASK_ENGINE.md) ────
    //
    // "Exactly-once by argument equality is not exactly-once." The run
    // journal replays a write only when the model re-issues BYTE-IDENTICAL
    // arguments; a re-worded retry sails straight past it and creates a
    // second record. That is how three invoices became 28
    // `create_schedule_item` calls across the 2026-08-03 routine runs — and
    // how the routine's net output became a manual cleanup chore.
    //
    // The fix follows `syncActionItemsToSchedule`'s `sourceEmailId + title`
    // precedent: a LEDGER of (scope :: normalized title) → record, in the
    // SYNCED schedule blob. It therefore survives a retry, a replan, a
    // verify re-run, a later run of the same routine, the record being
    // deleted by hand, and a second Mac firing the same routine
    // (ROUTINE_TRIGGERS.md T7 — a fail-open duplicate becomes a no-op).
    //
    // The SCOPE is HARNESS-supplied and never a tool argument: the thing
    // that makes the model's own writes converge must not be something the
    // model can vary or hallucinate. TaskService arms it around each
    // execution, exactly the way WriteLedger arms its capture window.
    _idemScope: null,
    IDEM_LEDGER_MAX: 400,
    // Below this length a containment match is not evidence of sameness
    // ("Pay" is inside everything). Same shape as `_matchItem`'s floor.
    IDEM_MIN_CONTAIN: 12,

    /** Lowercase, collapse whitespace, drop trailing punctuation — so
     *  "Pay invoice INV-2033." and "Pay  invoice INV-2033" are one key. */
    _normalizeRecordTitle(text) {
        return String(text || '')
            .toLowerCase().replace(/\s+/g, ' ').trim().replace(/[.!?,;:]+$/, '');
    },

    _idemLedger() {
        const l = (StorageManager.get('schedule') || {}).agentActionLedger;
        return (l && typeof l === 'object') ? l : {};
    },

    /**
     * The record this scope already created for `title`, or null.
     *
     * Exact normalized match first, then CONTAINMENT within the scope —
     * because the failure this exists for is a model re-wording its own
     * title on retry, and the live runs re-worded by appending ("… (dup 2)",
     * "… (dup 3)"). Containment is safe here in a way it would not be
     * globally: the scope is one run, or one routine's runs, so the
     * candidates are a handful of records the same instruction produced.
     * The trade is deliberate — a rare false merge costs one task that
     * reports `alreadyExisted`, while a false split costs the user a manual
     * cleanup, which is the cost this whole law was written against.
     */
    _idemFind(title) {
        const scope = this._idemScope;
        const norm = this._normalizeRecordTitle(title);
        if (!scope || !norm) return null;
        const led = this._idemLedger();
        const exact = led[`${scope}::${norm}`];
        if (exact) return exact;
        const prefix = `${scope}::`;
        for (const [k, v] of Object.entries(led)) {
            if (!k.startsWith(prefix) || !v) continue;
            const other = k.slice(prefix.length);
            const shorter = other.length <= norm.length ? other : norm;
            if (shorter.length >= this.IDEM_MIN_CONTAIN
                && (norm.includes(other) || other.includes(norm))) return v;
        }
        return null;
    },

    /** Remember a created record under the armed scope. No scope (ordinary
     *  chat) → nothing is written and behaviour is exactly as before. */
    _idemRemember(title, rec) {
        const scope = this._idemScope;
        const norm = this._normalizeRecordTitle(title);
        if (!scope || !norm) return;
        const data = StorageManager.get('schedule') || {};
        const led = { ...((data.agentActionLedger && typeof data.agentActionLedger === 'object')
            ? data.agentActionLedger : {}) };
        led[`${scope}::${norm}`] = { ...rec, at: new Date().toISOString() };
        // Bounded — this rides a synced blob. Oldest entries drop first.
        const keys = Object.keys(led);
        if (keys.length > this.IDEM_LEDGER_MAX) {
            keys.sort((a, b) => (Date.parse(led[a]?.at) || 0) - (Date.parse(led[b]?.at) || 0));
            for (const k of keys.slice(0, keys.length - this.IDEM_LEDGER_MAX)) delete led[k];
        }
        StorageManager.set('schedule', { ...data, agentActionLedger: led });
    },

    /**
     * Records a scope has already created — the evidence I8 hands a re-run
     * so it does not repeat a write it cannot prove is missing. Read by
     * TaskService._priorWritesNote; spans RUNS when the scope is a routine.
     */
    priorRecordsForScope(scope, limit = 15) {
        if (!scope) return [];
        const prefix = `${scope}::`;
        return Object.entries(this._idemLedger())
            .filter(([k, v]) => k.startsWith(prefix) && v)
            .sort((a, b) => (Date.parse(b[1].at) || 0) - (Date.parse(a[1].at) || 0))
            .slice(0, limit)
            .map(([, v]) => ({ tool: v.tool || 'create_schedule_item', title: v.title, id: v.id }));
    },

    mdToNoteHtml(md) {
        if (!md) return '';
        if (typeof AgentUI !== 'undefined' && typeof AgentUI.formatContent === 'function') {
            // literalHeadings: a note is a document, not a chat bubble — an
            // h1 read back as "#" must store as h1 again, or every AI edit
            // shrinks the user's headings a level.
            return AgentUI.formatContent(md, { literalHeadings: true });
        }
        const escaped = String(md)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
        return `<p>${escaped.replace(/\n/g, '</p><p>')}</p>`;
    },

        /**
     * Shared email filter for list_emails / scan_emails: account, folder,
     * from, date window, and free-text query using the UI's search engine
     * (words any order, typo tolerance, SQL body search over stored
     * bodies). Returns { pool (newest first), folder, coverage } — the
     * coverage block says how far back local mail goes, because nothing
     * older than that exists to be matched.
     */
    async _filterEmails(args = {}) {
        EmailApp.loadData();
        let pool = EmailApp.getProfileEmails() || [];

        if (args.account) {
            const want = String(args.account).toLowerCase();
            pool = pool.filter(e => (e.account || '').toLowerCase() === want);
        }

        // Folder filter — mirror EmailApp.getFilteredEmails label semantics
        const folder = (args.folder || 'inbox').toLowerCase();
        const labelMap = {
            inbox: 'INBOX', archive: 'ARCHIVE',
            trash: 'TRASH', sent: 'SENT'
        };
        if (folder === 'unread') {
            pool = pool.filter(e => !e.isRead && !(e.labels || []).includes('TRASH'));
        } else if (folder === 'priority') {
            pool = pool.filter(e =>
                EmailApp.isPrioritySender(e.from) &&
                !(e.labels || []).includes('TRASH')
            );
        } else if (folder === 'all') {
            pool = pool.filter(e => !(e.labels || []).includes('TRASH'));
        } else if (labelMap[folder]) {
            pool = pool.filter(e => (e.labels || []).includes(labelMap[folder]));
        }

        // From filter (substring on the From header)
        if (args.from) {
            const f = String(args.from).toLowerCase();
            pool = pool.filter(e => (e.from || '').toLowerCase().includes(f));
        }

        // Date window (YYYY-MM-DD; after inclusive, before exclusive)
        const afterTs = args.after ? Date.parse(args.after + 'T00:00:00') : null;
        const beforeTs = args.before ? Date.parse(args.before + 'T00:00:00') : null;
        if (afterTs) pool = pool.filter(e => new Date(e.date || 0).getTime() >= afterTs);
        if (beforeTs) pool = pool.filter(e => new Date(e.date || 0).getTime() < beforeTs);

        if (args.query && String(args.query).trim()) {
            const q = EmailApp._parseSearchQuery(String(args.query));
            let bodyHits = null;
            const needles = [...q.tokens, ...q.phrases];
            if (needles.length) {
                try {
                    const accounts = [...new Set(pool.map(e => e.account).filter(Boolean))];
                    const res = accounts.length
                        ? await window.electronEmailDb.searchBodies(accounts, needles) : {};
                    bodyHits = new Map(Object.entries(res || {}).map(([n, ids]) => [n, new Set(ids || [])]));
                } catch { /* header-only matching stands */ }
            }
            pool = pool.filter(e => EmailApp._emailMatchesSearch(e, q, bodyHits));
        }

        pool.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));

        const coverage = EmailApp.getAccounts().map(a => {
            const oldest = EmailApp._oldestEmailTs(a.email);
            return {
                account: a.email,
                oldestSyncedMail: oldest ? new Date(oldest).toISOString().slice(0, 10) : null,
                fullHistorySynced: !!EmailApp.backfillDone[a.email]
            };
        });

        return { pool, folder, coverage };
    },

    /**
     * Attach navigation buttons to a tool result.
     *
     * `ids` are HelpActions ids (help-actions.js); they are resolved HERE so
     * an unknown or currently-gated destination is dropped before the model
     * ever hears about it — the model must not be able to promise a button
     * the UI won't render. agent-service harvests `result.actions` off the
     * transcript into the turn's metadata (same deterministic path as
     * sources and record pills); agent-ui renders the row.
     *
     * `actionsShown` is for the MODEL: without it the answer reads "go to
     * Settings → Accounts" and stops, leaving the user to hunt for the page
     * the button is already offering.
     */
    _withActions(result, ids) {
        if (typeof HelpActions === 'undefined' || !result || result.error) return result;
        const actions = HelpActions.resolve(ids);
        if (!actions.length) return result;
        return {
            ...result,
            actions: actions.map(a => a.id),
            actionsShown: `Buttons taking the user straight to these pages are shown under your answer: ${actions.map(a => a.label).join(', ')}. Say what to do there in one line and tell them the button below opens it — never spell out a click path as the only way, and never invent buttons beyond this list.`
        };
    },

    /**
     * The macOS df trap (2026-08-19): `df` for "/" reports the sealed
     * read-only system volume, whose Used/Capacity columns count ONLY the
     * OS (~12 GB of a 460 GB disk reads "3% used") — the user's files live
     * on /System/Volumes/Data in the same APFS container. Shown that one
     * line, the model inverted the Capacity column ("97% available")
     * instead of computing Avail/Size (36%). Facts are arithmetic: when a
     * run_command result carries df output with a root mount, attach the
     * computed free percentage and say which columns lie. A note beside
     * verbatim stdout, never a rewrite of it.
     */
    _annotateDiskFree(result) {
        try {
            if (!result || result.error || !result.stdout) return result;
            if (!/(^|[\s|;&(/])df(\s|$)/.test(result.command || '')) return result;
            // "460Gi" / "460G" / bare block counts all parse; ratio only
            // needs the two sides on the same scheme, which df guarantees.
            const toUnits = (s) => {
                const m = /^([\d.]+)([KMGTPE])?I?B?$/i.exec(String(s || '').trim().toUpperCase());
                if (!m) return null;
                const exp = { K: 1, M: 2, G: 3, T: 4, P: 5, E: 6 }[m[2]] || 0;
                return parseFloat(m[1]) * Math.pow(1024, exp);
            };
            const root = result.stdout.split('\n')
                .map(ln => ln.trim().split(/\s+/))
                .find(f => f.length >= 6 && f[f.length - 1] === '/');
            if (!root) return result;
            const size = toUnits(root[1]);
            const avail = toUnits(root[3]);
            if (!size || avail === null || avail > size) return result;
            const pct = Math.round((avail / size) * 100);
            result.note = `macOS reading guide: the "/" line is the sealed read-only system volume — its Used and Capacity columns count only the OS, NOT the user's files, so never derive a used/free percentage from Capacity. Computed from this output's Size and Avail columns: ${root[3]} free of ${root[1]} (~${pct}% free). The user's files live on /System/Volumes/Data, which shares the same free space.`;
            return result;
        } catch { return result; }
    },

    /**
     * Attach saved per-record decisions to a read result — the recall half
     * of the Decisions feature (save_decision writes, this makes reads
     * carry them without the model having to ask). `mounts` is
     * [{key, into}]: `key` a DecisionStore key ('goal:<id>'), `into` the
     * object that receives the `decisions` array — the result itself for a
     * single-record read, the list item for a list read.
     *
     * Shared budget per RESULT (the _portfolioStrategyNotes rule): the 6k
     * hard-trim in agent-service destroys JSON shape, so past the budget a
     * record degrades to a count + list_decisions pointer instead of
     * blowing the cap. No trim exemption on purpose — decision bodies are
     * user/model text, not an authored corpus like get_help's.
     *
     * Skipped wholesale when ctx.untrusted: a turn reading hostile input
     * must not have the user's standing instructions pulled into context
     * (the tool-list half of that policy is UNTRUSTED_BLOCKED_TOOLS).
     */
    _withDecisions(result, mounts, ctx) {
        if (typeof DecisionStore === 'undefined' || !result || result.error) return result;
        if (ctx && ctx.untrusted) return result;
        let budget = 2400;
        const PER_ITEM = 400;
        let attached = 0;
        for (const m of (mounts || [])) {
            if (!m || !m.key || !m.into) continue;
            const list = DecisionStore.listFor(m.key);
            if (!list.length) continue;
            const items = [];
            for (const d of list) {
                const cap = Math.min(PER_ITEM, budget);
                if (cap < 120) break;
                const body = d.body || '';
                const text = body.length > cap ? body.slice(0, cap) + '…' : body;
                budget -= text.length;
                items.push({
                    id: d.id,
                    title: d.title,
                    decision: text,
                    savedAt: d.createdAt,
                    ...(d.source === 'user' ? { addedByUser: true } : {})
                });
            }
            // Concat, not assign — get_note mounts note: and routine: keys
            // onto the SAME result object.
            if (items.length) m.into.decisions = (m.into.decisions || []).concat(items);
            if (items.length < list.length) {
                const sep = m.key.indexOf(':');
                const more = `${list.length - items.length} more — list_decisions type=${m.key.slice(0, sep)} id=${m.key.slice(sep + 1)}`;
                m.into.decisionsMore = m.into.decisionsMore ? `${m.into.decisionsMore}; ${more}` : more;
            }
            attached += items.length;
        }
        if (attached && !result.decisionsShown) {
            result.decisionsShown = 'Saved decisions are attached under `decisions` — the user\'s standing instructions for that record. Follow them, and factor them into any advice about it.';
        }
        return result;
    },

    handlers: {
        // ── META ──

        /**
         * No-op reasoning tool. Records the thought for debugging via
         * console + LLMLogger but has no other side effect. Pattern from
         * Anthropic's "think" tool post (Mar 2025) — gives the model an
         * explicit place to slow down before destructive actions or when
         * processing large tool results, without paying the latency tax
         * of always-on extended thinking.
         */
        think({ thought }) {
            const text = typeof thought === 'string' ? thought.trim() : '';
            if (!text) return { ok: false, error: 'thought required' };
            return { ok: true };
        },

        /**
         * The in-app user guide (HelpDocs, help-docs.js). Unknown or missing
         * topic returns the index instead of an error — cheaper for a small
         * model to recover from than a retry loop.
         *
         * `actions` on the result names the pages this doc sends people to.
         * agent-service harvests them off the tool result and agent-ui
         * renders them as buttons under the answer — the model never has to
         * (and never gets to) author a navigation link. The `actionsShown`
         * line tells it so, because a model that doesn't know the buttons
         * exist writes "go to Settings → Accounts" and stops there.
         */
        get_help({ topic } = {}) {
            if (typeof HelpDocs === 'undefined') return { error: 'Help docs unavailable' };
            const doc = topic ? HelpDocs.get(String(topic)) : null;
            if (doc) return AgentTools._withActions(doc, doc.actions);
            return { topics: HelpDocs.index(), note: topic ? `Unknown topic "${topic}" — pick one of these.` : 'Pick the closest topic and call get_help again.' };
        },

        /**
         * What is actually set up on THIS Mac. The guide says how to connect
         * Gmail; this says whether it is connected — without it the
         * assistant answers "how do I connect Gmail?" with instructions to
         * someone who connected it last month, and can never say "you
         * haven't set X up yet" on its own initiative.
         *
         * Read-only and machine-local by nature (accounts, models, keys and
         * search providers are all per-Mac). No secret values ever leave
         * here — presence only.
         */
        async get_setup_status() {
            const out = {};

            // Google accounts (Gmail + Calendar ride the same connection).
            try {
                const accounts = (typeof AccountsManager !== 'undefined' ? AccountsManager.getAll() : []) || [];
                out.accounts = {
                    connected: accounts.length,
                    emails: accounts.map(a => a.email).filter(Boolean),
                    mail: accounts.some(a => a.services?.mail === true),
                    calendar: accounts.some(a => a.services?.calendar === true)
                };
            } catch { out.accounts = { connected: 0, emails: [], mail: false, calendar: false }; }

            // The brain. `engine` is where it runs: llamacpp (this Mac),
            // server (the user's own), openai/anthropic (their own key).
            try {
                const entries = (typeof AgentService !== 'undefined' && AgentService.getModelList()) || [];
                const def = typeof AgentService !== 'undefined' ? AgentService.getDefaultEntry?.() : null;
                out.ai = {
                    configured: !!def,
                    defaultModel: def?.model || null,
                    engine: def?.engine || null,
                    modelsInstalled: entries.length
                };
            } catch { out.ai = { configured: false, defaultModel: null, engine: null, modelsInstalled: 0 }; }

            // Web search — off until explicitly enabled (see the web-search doc).
            try {
                const s = await window.electronSearch?.getStatus?.();
                out.webSearch = { enabled: !!(s && s.enabled), provider: (s && s.provider) || null };
            } catch { out.webSearch = { enabled: false, provider: null }; }

            // Multi-Mac sync — opt-in, per-Mac.
            try {
                const st = await window.electronSync?.getStatus?.();
                const peers = ((st && st.machines) || []).filter(m => !m.isCurrent).length;
                out.sync = { enabled: !!(st && st.enabled), otherMacs: peers };
            } catch { out.sync = { enabled: false, otherMacs: 0 }; }

            // The setup checklist's own view of what is left, so the
            // assistant and the Settings card can never disagree about it.
            const pending = [];
            try {
                if (typeof SetupAssistant !== 'undefined') {
                    for (const step of SetupAssistant.steps()) {
                        if (!step.done) pending.push({ id: step.id, title: step.title });
                    }
                }
            } catch { /* checklist unavailable — the fields above still answer */ }
            out.setupStepsPending = pending;

            // Buttons: only for what is NOT set up. A door to a thing the
            // user already did is noise under an answer, and the whole point
            // of this tool is naming the gap.
            const ids = [];
            if (!out.accounts.connected) ids.push('connect-google');
            if (!out.ai.configured) ids.push('ai-models');
            if (!out.webSearch.enabled) ids.push('web-search');
            if (pending.length) ids.push('setup-checklist');
            return AgentTools._withActions(out, ids);
        },

        // ── READ ──

        list_goals(args, ctx) {
            const data = StorageManager.get('goals');
            let goals = data?.goals || [];

            if (!args.include_completed) {
                goals = goals.filter(g => g.status !== 'completed');
            }
            // Horizon filter over targetDate (accepts legacy `type` arg name).
            const horizon = args.due_within || args.type;
            if (horizon) {
                const end = new Date();
                if (horizon === 'week') end.setDate(end.getDate() + (7 - end.getDay()) % 7);
                else if (horizon === 'month') end.setMonth(end.getMonth() + 1, 0);
                else if (horizon === 'year') end.setMonth(11, 31);
                const endStr = `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, '0')}-${String(end.getDate()).padStart(2, '0')}`;
                goals = goals.filter(g => g.targetDate && g.targetDate <= endStr);
            }
            const d = new Date();
            const localToday = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
            // Whole days since the goal was created — reviews need this to
            // tell "just starting" from "stalled" (a day-old goal with no
            // completed tasks is new, not stuck).
            const ageDays = (iso) => {
                const t = Date.parse(iso || '');
                return Number.isFinite(t) ? Math.max(0, Math.floor((Date.now() - t) / 86400000)) : null;
            };
            // Per-goal task cap, applied HERE rather than left to the generic
            // trims: the tasks array is NESTED, so agent-service's structural
            // 25-item cap never sees it and the 6k byte-trim turned a 36-task
            // goal into a JSON preview cut mid-record — the model could never
            // enumerate a big goal's tasks. Over the cap, the wrapper mirrors
            // agent-service's truncation shape (the model already knows it)
            // and points at the read that returns the whole list.
            const GOAL_TASKS_CAP = 12;
            const result = {
                today: localToday,
                goals: goals.map(g => {
                    // Open linked tasks. Done = completed today for repeating
                    // tasks, ever for one-time (tasks have lastCompletedDate,
                    // not a flag); abandoned counts as done either way.
                    const open = LinkManager.getTasksForGoal(g.id).filter(t => {
                        const done = (t.repeat && t.repeat !== 'none')
                            ? (t.lastCompletedDate === localToday || isAbandonedOnDate(t, localToday))
                            : (!!t.lastCompletedDate || isOneTimeAbandoned(t));
                        return !done;
                    }).map(t => ({
                        id: t.itemId, title: t.title, startTime: formatTime12h(t.startTime),
                        scheduledDate: t.scheduledDate || null, repeat: t.repeat
                    }));
                    return {
                        id: g.id, title: g.title, targetDate: g.targetDate || null, status: g.status,
                        ageDays: ageDays(g.createdAt),
                        group: (typeof g.group === 'string' && g.group.trim()) || null,
                        tasks: open.length > GOAL_TASKS_CAP
                            ? { _truncated: true, taskCount: open.length, shownCount: GOAL_TASKS_CAP,
                                note: `Call list_schedule with goal:"${g.title}" for this project's full task list.`,
                                items: open.slice(0, GOAL_TASKS_CAP) }
                            : open
                    };
                })
            };
            return AgentTools._withDecisions(result,
                result.goals.map(g => ({ key: `goal:${g.id}`, into: g })), ctx);
        },

        list_schedule(args, ctx) {
            // GOAL SCOPE — the read half of bulk rescheduling: every live
            // task linked to one goal, compact rows, all dates. Live = not
            // resolved for good (one-time tasks completed/abandoned are out;
            // repeating tasks always recur, so they're always live — this is
            // "what's scheduled", where list_goals' filter answers "what's
            // left to do today"). agent-service lifts its 25-item array cap
            // for this shape (result.goalScoped) — a 36-task goal must come
            // back whole, that being the point of the filter.
            if (args.goal) {
                const goals = (StorageManager.get('goals')?.goals) || [];
                const goal = AgentTools.findBySearchOrId(goals, args.goal, args.goal);
                if (!goal) return { error: `No project matching "${args.goal}". Call list_goals for titles and ids.` };
                let tasks = LinkManager.getTasksForGoal(goal.id)
                    .map(t => ({ ...t, id: t.itemId }))
                    .filter(t => AgentTools._isLiveTask(t));
                if (args.search) {
                    tasks = tasks.filter(t =>
                        AgentTools.wordsMatch((t.title || '') + ' ' + (t.description || ''), args.search));
                }
                tasks.sort((a, b) =>
                    (a.scheduledDate || '9999').localeCompare(b.scheduledDate || '9999')
                    || (a.startTime || '').localeCompare(b.startTime || ''));
                const total = tasks.length;
                if (tasks.length > 60) tasks = tasks.slice(0, 60);
                const result = {
                    goalScoped: true,
                    goal: { id: goal.id, title: goal.title, targetDate: goal.targetDate || null },
                    itemCount: total,
                    ...(total > tasks.length
                        ? { note: `Showing the first ${tasks.length} of ${total} by date.` } : {}),
                    items: tasks.map(t => ({
                        id: t.id, title: String(t.title || '').slice(0, 80),
                        date: t.scheduledDate || null,
                        overdue: (t.scheduledDate && t.scheduledDate < getDateStr(0) && !(t.repeat && t.repeat !== 'none')) ? true : undefined,
                        start: formatTime12h(t.startTime) || undefined,
                        repeat: t.repeat && t.repeat !== 'none' ? t.repeat : undefined
                    }))
                };
                return AgentTools._withDecisions(result,
                    result.items.map(i => ({ key: `task:${i.id}`, into: i })), ctx);
            }

            const data = StorageManager.get('schedule');
            const _today = getDateStr(0);
            let items = (data?.scheduleItems || []).filter(i =>
                    (!i.lastCompletedDate || i.lastCompletedDate === _today) && !isOneTimeAbandoned(i));

            // Resolve filter to a target date. A search means "find this task
            // wherever it is" — default to all dates, not today.
            const filter = (args.filter || (args.search ? 'all' : 'today')).trim().toLowerCase();
            const today = getDateStr(0);
            let targetDate = null;
            let filterLabel = filter;

            if (filter === 'today') {
                targetDate = today;
                filterLabel = 'today';
            } else if (filter === 'tomorrow') {
                targetDate = getDateStr(1);
                filterLabel = 'tomorrow';
            } else if (filter === 'yesterday') {
                targetDate = getDateStr(-1);
                filterLabel = 'yesterday';
            } else if (/^\d{4}-\d{2}-\d{2}$/.test(filter)) {
                targetDate = filter;
                filterLabel = filter;
            }

            if (targetDate) {
                if (filter === 'today') {
                    // Use exact same logic as Tasks app UI
                    ScheduleApp.loadData();
                    items = ScheduleApp.scheduleItems
                        .filter(i => ScheduleApp.isItemForToday(i)
                            && !ScheduleApp.isCompletedToday(i)
                            && !ScheduleApp.isAbandonedToday(i)
                            && !isOneTimeAbandoned(i));
                } else {
                    items = items.filter(i => isItemForDate(i, targetDate));
                    items = items.filter(i => i.lastCompletedDate !== targetDate);
                }
            } else if (filter === 'week') {
                // Show items for the next 7 days
                const dates = Array.from({ length: 7 }, (_, i) => getDateStr(i));
                items = items.filter(item => dates.some(d => isItemForDate(item, d)));
            }
            // filter === 'all' — no filtering

            // Keyword search — applied BEFORE the tool-result array cap, so a
            // matching task is found even in a schedule far larger than the
            // 25-item truncation window (the failure mode: a task at position
            // 48 of 70 was invisible to the model and reported "not found").
            if (args.search) {
                items = items.filter(i =>
                    AgentTools.wordsMatch((i.title || '') + ' ' + (i.description || ''), args.search));
            }

            const now = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

            // Sort by start time
            items.sort((a, b) => (a.startTime || '').localeCompare(b.startTime || ''));

            // Every row carries ITS OWN date. The envelope's `date` is only
            // the query day (a single-day filter); for all/week/search it
            // is omitted, because a 4B reading `{date: <today>, items:[{start:
            // "2:00 PM"}]}` for a search hit concluded the task was "already
            // scheduled for today" — the only date in sight was the query's
            // — and declined to move five overdue tasks (2026-08-30).
            // `overdue` is the same arithmetic as ScheduleApp.getGroupedItems
            // (dated, one-time, before today), so the model is told, not
            // left to compare strings.
            const result = {
                filter: filterLabel, search: args.search || undefined,
                today, date: targetDate || undefined, currentTime: now,
                itemCount: items.length,
                items: items.map(i => {
                    const recurring = !!(i.repeat && i.repeat !== 'none');
                    const date = i.scheduledDate || null;
                    return {
                        id: i.id, title: i.title,
                        date,
                        overdue: (!recurring && date && date < today) ? true : undefined,
                        start: formatTime12h(i.startTime), end: formatTime12h(i.endTime),
                        repeat: recurring ? i.repeat : undefined,
                        goal: LinkManager.getGoalForTask(i.id)?.title || undefined
                    };
                })
            };
            return AgentTools._withDecisions(result,
                result.items.map(i => ({ key: `task:${i.id}`, into: i })), ctx);
        },

        list_notes(args, ctx) {
            const data = StorageManager.get('notes');
            let notes = data?.notes || [];

            if (args.search) {
                const q = args.search.toLowerCase();
                notes = notes.filter(n =>
                    n.title?.toLowerCase().includes(q) ||
                    n.content?.toLowerCase().includes(q)
                );
            }

            // Snippet only — enough to tell two similar notes apart and decide
            // which to get_note. The body itself never rides a list call: 20
            // notes of full content would swamp the context window — and by
            // the same rule decisions ride as a COUNT here, bodies on get_note.
            return { notes: notes.slice(0, 20).map(n => {
                const decisionCount = (typeof DecisionStore !== 'undefined' && !(ctx && ctx.untrusted))
                    ? DecisionStore.listFor(`note:${n.id}`).length : 0;
                return {
                    id: n.id, title: n.title, tags: n.tags, pinned: n.pinned,
                    snippet: AgentTools._noteText(n).slice(0, 120),
                    ...(decisionCount ? { decisionCount } : {})
                };
            }) };
        },

        // Notes are the one personal-data app whose content the agent could
        // match on but never read back, which left it asking the user to paste
        // in text the app was already holding. Shape mirrors fs_read.
        get_note(args, ctx) {
            const data = StorageManager.get('notes');
            const notes = data?.notes || [];
            const note = notes.find(n => n.id === args.id || String(n.id) === String(args.id));
            if (!note) return { error: `No note with id ${args.id}. Call list_notes or search_all to get valid ids.` };

            // Markdown, not the plain-text flatten: this read feeds edits
            // (get_note → update_note replaces the body), so structure the
            // model never sees is structure the rewrite destroys.
            const text = AgentTools.noteHtmlToMd(note.content);
            const start = Math.max(0, parseInt(args.offset, 10) || 0);
            const result = {
                id: note.id,
                title: note.title,
                tags: note.tags,
                pinned: note.pinned,
                format: 'markdown',
                content: '',
                offset: start,
                totalChars: text.length,
                truncated: false,
            };
            if (/<img\b/i.test(note.content || '')) {
                result.hasImages = true;
                result.imagesNote = 'This note contains images, which markdown cannot carry — '
                    + 'replacing content would drop them. Prefer append, or warn the user first.';
            }
            // A routine IS a prompt note, and list_routines points here for
            // the full body — so a routine's decisions must ride this read
            // too, under whichever key they were saved.
            const mounts = [{ key: `note:${note.id}`, into: result }];
            if (typeof NotePrompts !== 'undefined' && NotePrompts.isPrompt(note)) {
                mounts.push({ key: `routine:${note.id}`, into: result });
            }
            AgentTools._withDecisions(result, mounts, ctx);

            // Size the content slice against what the decisions/metadata left
            // of the 6k result budget (the get_email mould) — a full
            // NOTE_READ_CAP slice plus overhead used to clear the hard-trim,
            // which cut the JSON mid-record.
            const overhead = JSON.stringify(result).length;
            let slice = text.slice(start, start
                + Math.max(1000, Math.min(AgentTools.NOTE_READ_CAP, 5600 - overhead)));
            result.content = slice;
            // JSON escaping can inflate the stringified content past the budget
            while (slice.length > 500 && JSON.stringify(result).length > 5800) {
                slice = slice.slice(0, Math.floor(slice.length * 0.9));
                result.content = slice;
            }
            result.truncated = start + slice.length < text.length;
            if (result.truncated) {
                result.contentNote = `Content is ${text.length} chars; showing ${slice.length} from offset ${start}. Call get_note again with offset ${start + slice.length} to continue.`;
            }
            return result;
        },

        // journal handlers live in js/apps/journal/journal-tools.js

        async web_search(args) {
            if (!args?.query || !String(args.query).trim()) return { error: 'query required' };
            if (typeof window.electronSearch?.query !== 'function') {
                return { error: 'Web search not available in this build.' };
            }
            // Reaching the handler in the never-chosen state means the user
            // just APPROVED the first search (AgentService._resolvePermission
            // ask-gates it) — that approval is the opt-in: flip the master
            // toggle + built-in provider so Settings shows the truth. The
            // Connect key still mints lazily inside the query itself.
            try {
                const st = await window.electronSearch.getStatus?.();
                if (st?.unset) {
                    await window.electronSearch.setEnabled?.(true);
                    await window.electronSearch.setProvider?.('anjadhe');
                    if (typeof AgentService !== 'undefined') await AgentService._ensureWebSearchState(true);
                }
            } catch { /* the query below reports its own errors */ }
            const query = String(args.query).trim();
            const start = performance.now();
            const response = await window.electronSearch.query(query, args.maxResults);
            const durationMs = performance.now() - start;
            if (typeof SearchLogger !== 'undefined') {
                SearchLogger.record({
                    query,
                    durationMs,
                    results: response?.results,
                    error: response?.error,
                    provider: response?.provider
                });
            }
            return response;
        },

        async read_url(args) {
            const url = (args?.url || '').trim();
            if (!url) return { error: 'url required' };
            if (typeof window.electronSearch?.read !== 'function') {
                return { error: 'Page reading not available in this build.' };
            }
            // Main enforces the real guards (scheme, content type, size caps,
            // context-budget excerpting) — see read-url in main.js.
            return await window.electronSearch.read(url, args?.find);
        },









        /**
         * Delegates to GlobalSearch, which also backs the ⌘K palette — one
         * search implementation rather than two that drift apart. The result
         * SHAPE is unchanged (flat records with the same per-app extra
         * fields); what improved is ranking. It used to return whatever the
         * scan found in registration order and cut at 20, which let a long
         * goals list starve notes entirely.
         */

        search_all(args) {
            const q = (args.query || '').trim();
            if (!q) return { results: [] };
            return {
                results: GlobalSearch.data(q, 20).map(({ app, id, title, meta }) => ({
                    app, id, title, ...(meta || {})
                }))
            };
        },

        // ── WRITE ──

        create_goal(args) {
            const data = StorageManager.get('goals') || {};
            const goals = data.goals || [];

            // Dedup: reuse an existing goal rather than duplicating it.
            let goal;
            let alreadyExisted = false;
            const existing = goals.find(g => g.title?.toLowerCase() === args.title.toLowerCase());
            if (existing) {
                goal = existing;
                alreadyExisted = true;
            } else {
                const now = new Date().toISOString();
                goal = {
                    id: UIUtils.generateId(),
                    title: args.title,
                    description: args.description || '',
                    group: typeof args.group === 'string' ? args.group.trim() : '',
                    targetDate: /^\d{4}-\d{2}-\d{2}$/.test(args.targetDate || '') ? args.targetDate : null,
                    status: 'not-started',
                    createdAt: now,
                    modifiedAt: now
                };
                goals.unshift(goal);
                StorageManager.set('goals', { goals });
                AgentTools.refreshApp('goals');
            }

            return { success: true, goal: { id: goal.id, title: goal.title, group: goal.group || null, targetDate: goal.targetDate || null, status: goal.status }, alreadyExisted };
        },

        update_goal(args) {
            const data = StorageManager.get('goals') || {};
            const goals = data.goals || [];
            const goal = AgentTools.findBySearchOrId(goals, args.search, args.id);
            if (!goal) return { error: `Project not found matching "${args.search || args.id}"` };

            const oldTitle = goal.title;
            if (args.new_title !== undefined) goal.title = args.new_title;
            if (args.group !== undefined) goal.group = String(args.group).trim();
            if (args.targetDate !== undefined) {
                goal.targetDate = /^\d{4}-\d{2}-\d{2}$/.test(args.targetDate) ? args.targetDate : null;
            }
            // A goal is either completed or it is not. Old callers passing a
            // working status mean "not completed".
            if (args.completed !== undefined) {
                goal.status = args.completed ? 'completed' : 'not-started';
            } else if (args.status !== undefined) {
                goal.status = args.status === 'completed' ? 'completed' : 'not-started';
            }
            delete goal.completed;
            goal.modifiedAt = new Date().toISOString();

            StorageManager.set('goals', { goals });
            AgentTools.refreshApp('goals');

            // A rename carries the project's review routine (and any routine
            // quoting the old title) along. Legacy "Goal Review: " titles
            // are healed first so the convention match sees the current
            // prefix.
            if (goal.title !== oldTitle) GoalInterview._migrateReviewTitles();
            const routines = goal.title !== oldTitle
                ? ReviewRoutines.syncRename(GoalInterview.GOAL_REVIEW_PREFIX, oldTitle, goal.title)
                : { updated: [], mentions: [] };

            return {
                success: true,
                goal: { id: goal.id, title: goal.title, group: goal.group || null, targetDate: goal.targetDate || null, status: goal.status },
                ...(routines.updated.length ? { routinesUpdated: routines.updated } : {}),
                ...(routines.mentions.length
                    ? { routinesStillMentioningOldName: routines.mentions,
                        renameNote: 'These routines mention the old project title loosely and were NOT changed — tell the user, who can edit them on the Routines page.' } : {})
            };
        },

        delete_goal(args = {}) {
            // Same guardrails as delete_schedule_item: an id or a specific
            // search that resolves to exactly one goal, else candidates.
            const search = (args.search || '').trim();
            const id = args.id || null;
            if (!id && !search) {
                return { error: 'delete_goal requires either "search" or "id".' };
            }
            if (!id && search.length < 3) {
                return { error: `Search "${search}" is too short (minimum 3 characters). Use a more specific title or pass an id.` };
            }

            const data = StorageManager.get('goals') || {};
            const goals = data.goals || [];
            let goal = null;
            if (id) {
                goal = goals.find(g => g.id === id);
                if (!goal) return { error: `No project with id "${id}".` };
            } else {
                const q = search.toLowerCase();
                const exact = goals.filter(g => (g.title || '').toLowerCase() === q);
                if (exact.length === 1) {
                    goal = exact[0];
                } else if (exact.length > 1) {
                    return {
                        error: `Search "${search}" matches ${exact.length} projects with the exact same title. Pass an explicit id to disambiguate.`,
                        candidates: exact.map(g => ({ id: g.id, title: g.title, group: g.group || null }))
                    };
                } else {
                    const partial = goals.filter(g => (g.title || '').toLowerCase().includes(q));
                    if (partial.length === 0) return { error: `No project found matching "${search}".` };
                    if (partial.length > 1) {
                        return {
                            error: `Search "${search}" is ambiguous — it matches ${partial.length} projects. Retry with a more specific search or pass an explicit id from the candidates.`,
                            candidates: partial.slice(0, 10).map(g => ({ id: g.id, title: g.title, group: g.group || null }))
                        };
                    }
                    goal = partial[0];
                }
            }

            // Tasks first, then the goal — a deleted goal must not leave
            // its schedule items behind as orphans (the page UI refuses to
            // delete a goal with tasks still linked for the same reason).
            const taskIds = new Set(
                LinkManager.getLinksForApp('goals', goal.id, 'schedule').map(l => l.itemId));
            const sched = StorageManager.get('schedule') || {};
            const items = sched.scheduleItems || [];
            const deletedTasks = items
                .filter(i => taskIds.has(i.id))
                .map(i => ({ id: i.id, title: i.title, scheduledDate: i.scheduledDate || null }));
            if (taskIds.size) {
                for (const tid of taskIds) LinkManager.removeAllLinksForItem('schedule', tid);
                // Spread preserves the rest of the blob (emailActionLedger —
                // same care as delete_schedule_item).
                StorageManager.set('schedule', { ...sched, scheduleItems: items.filter(i => !taskIds.has(i.id)) });
                AgentTools.refreshApp('schedule');
            }

            LinkManager.removeAllLinksForItem('goals', goal.id);
            StorageManager.set('goals', { ...data, goals: goals.filter(g => g.id !== goal.id) });
            AgentTools.refreshApp('goals');

            const result = {
                success: true,
                deleted: { id: goal.id, title: goal.title, group: goal.group || null },
                deletedTasks
            };
            // The weekly review routine is linked by title and outlives the
            // goal — surface it so the model can offer the cleanup, which
            // stays a separate consent (delete_routine has its own dialog).
            const routine = (typeof ReviewRoutines !== 'undefined' && goal.title)
                ? GoalInterview.findReview(goal.title) : null;
            if (routine) {
                result.reviewRoutineNote = `The project's review routine "${routine.title}" (id ${routine.id}) still exists — offer to remove it with delete_routine.`;
            }
            return result;
        },

        start_goal_interview(args = {}) {
            const existing = args.title ? GoalInterview.find(args.title) : null;
            GoalsApp.loadGoals();
            const goal = existing
                || GoalsApp.goals.find(g => g.status === 'draft')
                || null;

            const missing = GoalInterview.missingTopics(goal);
            const next = missing.length ? GoalInterview.topic(missing[0]) : null;

            // Existing groups and goals ride along so the group topic can be
            // a proposal from what the user already organizes by, and so a
            // "new" goal that already exists is continued, not duplicated.
            const active = GoalsApp.goals.filter(g => g.status !== 'completed');
            const context = {
                today: ScheduleApp.getLocalToday(),
                groups: GoalsApp.getGroups().filter(g => g !== GoalsApp.UNGROUPED),
                existingGoals: active.slice(0, 30).map(g => ({
                    title: g.title, group: (g.group || '').trim() || null,
                    status: g.status, targetDate: g.targetDate || null
                }))
            };

            return {
                instructions:
                    'Run this as an interview, not a form. Ask ONE topic at a time, in the order given, ' +
                    'and wait for the answer before moving on. For each: ask the question in your own words, ' +
                    'say in a sentence why it matters (use `why`), and offer the examples as a starting point ' +
                    'so the user has something to react to. After each answer, call save_goal with just that ' +
                    'field — it merges, so an interrupted conversation still leaves a usable draft. save_goal ' +
                    'needs a title from the very first call, so use their outcome answer as the title. ' +
                    'Do not ask every topic at once, do not add topics of your own, and never save anything ' +
                    'the user did not say or approve. For the steps topic, PROPOSE the task breakdown yourself ' +
                    'from the outcome and target date and let them edit it; for the group topic, propose the ' +
                    'best match from context.groups. When nothing is left, read the plan back in a few lines — ' +
                    'outcome, date, task timeline — then offer the weekly AI review (save_goal with ' +
                    'startWeeklyReview: true) unless they already said no.',
                goal: goal ? { title: goal.title, status: goal.status } : null,
                covered: goal
                    ? GoalInterview.INTERVIEW.filter(t => !missing.includes(t.id)).map(t => t.id)
                    : [],
                remaining: missing,
                nextTopic: next,
                agenda: GoalInterview.INTERVIEW.map(t => ({
                    id: t.id, question: t.question, why: t.why,
                    examples: t.examples, hint: t.hint
                })),
                context
            };
        },

        save_goal(args = {}) {
            if (!args.title || !String(args.title).trim()) {
                return { error: 'A project needs a title.' };
            }
            const { goal, tasksAdded, routines } = GoalInterview.save(args);
            AgentTools.refreshApp('goals');
            if (tasksAdded) AgentTools.refreshApp('schedule');

            const missing = GoalInterview.missingTopics(goal);
            const next = missing.length ? GoalInterview.topic(missing[0]) : null;
            return {
                success: true,
                goal: { id: goal.id, title: goal.title },
                group: goal.group || null,
                status: goal.status,
                tasksAdded,
                ...(routines && routines.updated.length
                    ? { routinesUpdated: routines.updated } : {}),
                ...(routines && routines.mentions.length
                    ? { routinesStillMentioningOldName: routines.mentions,
                        renameNote: 'These routines mention the old project title loosely and were NOT changed — tell the user, who can edit them on the Routines page.' } : {}),
                missing,
                nextTopic: next,
                hint: next
                    ? 'Ask the next question. Do not summarize the whole plan yet.'
                    : 'The plan is complete. Read it back in a few lines — outcome, target date, task timeline — then offer the weekly AI review (save_goal with startWeeklyReview: true) if they have not already said no.'
            };
        },

        create_schedule_item(args) {
            if (!args.title || !String(args.title).trim()) {
                return { error: 'A task needs a title.' };
            }
            const data = StorageManager.get('schedule') || {};
            const items = data.scheduleItems || [];

            // I8 (docs/TASK_ENGINE.md): the harness-scoped idempotency ledger
            // is consulted BEFORE the title match, because it is the only one
            // of the two that survives the user deleting the record — and a
            // retry that resurrects a task the user deleted is the same bug
            // wearing a different hat.
            const prior = AgentTools._idemFind(args.title);
            if (prior && !items.some(i => i.id === prior.id)) {
                return {
                    success: true, alreadyExisted: true, idempotent: true,
                    note: 'This work already created that task and it has since been deleted — it was NOT created again.'
                };
            }

            // Dedup: reuse existing item but still attempt linking. The title
            // match is normalized (whitespace, trailing punctuation) so a
            // re-worded retry converges instead of forking — the same
            // tolerance the email insight sync has had all along.
            let item;
            let alreadyExisted = false;
            const norm = AgentTools._normalizeRecordTitle(args.title);
            const existing = (prior && items.find(i => i.id === prior.id))
                || items.find(i => AgentTools._normalizeRecordTitle(i.title) === norm);
            if (existing) {
                item = existing;
                alreadyExisted = true;
            } else {
                const now = new Date();
                // Resolve scheduledDate: accept YYYY-MM-DD, "today", "tomorrow", or default to today
                let scheduledDate;
                if (args.scheduledDate === 'tomorrow') {
                    scheduledDate = getDateStr(1);
                } else if (!args.scheduledDate || args.scheduledDate === 'today') {
                    scheduledDate = getDateStr(0);
                } else {
                    scheduledDate = args.scheduledDate; // assume YYYY-MM-DD
                }
                item = {
                    id: UIUtils.generateId(),
                    title: args.title,
                    description: args.description || '',
                    startTime: args.startTime || '',
                    endTime: args.endTime || '',
                    repeat: args.repeat === 'once' ? 'none' : (args.repeat || 'none'),
                    completed: false,
                    scheduledDate: scheduledDate,
                    createdAt: now.toISOString()
                };

                if (item.repeat === 'weekly') {
                    const d = new Date(scheduledDate + 'T12:00:00');
                    item.dayOfWeek = d.getDay();
                }

                items.push(item);
                // Preserve emailActionLedger / other blob keys (see complete_task).
                StorageManager.set('schedule', { ...data, scheduleItems: items });
                AgentTools.refreshApp('schedule');
            }

            // Remember it under the run's scope, so a re-worded retry, a
            // replan, a verify re-run — or the next fire of the same routine
            // — converges here instead of forking a second record.
            AgentTools._idemRemember(args.title, {
                id: item.id, title: item.title, tool: 'create_schedule_item'
            });

            // Auto-link to goal if provided
            let linkedGoal = null;
            if (args.goalTitle) {
                const goals = (StorageManager.get('goals') || {}).goals || [];
                const goal = AgentTools.findBySearchOrId(goals, args.goalTitle);
                if (goal) {
                    LinkManager.addLink('goals', goal.id, 'schedule', item.id);
                    linkedGoal = goal.title;
                }
            }

            return { success: true, item: { id: item.id, title: item.title, startTime: item.startTime, endTime: item.endTime, linkedGoal }, alreadyExisted };
        },

        update_schedule_item(args) {
            const data = StorageManager.get('schedule') || {};
            const items = data.scheduleItems || [];
            const item = AgentTools.findBySearchOrId(items, args.search, args.id);
            if (!item) return { error: `Schedule item not found matching "${args.search || args.id}"` };

            // Reject blank titles — clearing the title is never a valid edit and
            // is the failure mode the agent used to fall into when asked to "remove"
            // a task without a real delete tool. Use delete_schedule_item instead.
            if (args.new_title !== undefined) {
                if (typeof args.new_title !== 'string' || args.new_title.trim() === '') {
                    return { error: 'new_title cannot be empty. To remove a task, use delete_schedule_item.' };
                }
                item.title = args.new_title;
            }
            if (args.description !== undefined) item.description = args.description;
            if (args.startTime !== undefined) item.startTime = args.startTime;
            if (args.endTime !== undefined) item.endTime = args.endTime;
            if (args.scheduledDate !== undefined) {
                if (args.scheduledDate === 'tomorrow') item.scheduledDate = getDateStr(1);
                else if (args.scheduledDate === 'today') item.scheduledDate = getDateStr(0);
                else item.scheduledDate = args.scheduledDate;
            }
            if (args.repeat !== undefined) item.repeat = args.repeat;

            // Preserve emailActionLedger / other blob keys (see complete_task).
            StorageManager.set('schedule', { ...data, scheduleItems: items });
            AgentTools.refreshApp('schedule');

            return { success: true, item: { id: item.id, title: item.title, startTime: item.startTime, endTime: item.endTime } };
        },

        // Bulk reschedule: ONE atomic write over the plan _shiftPlan computed
        // (the same plan the consent dialog showed — one builder). 41 dates
        // move in one StorageManager.set, so a timeout can never strand the
        // schedule half-shifted the way a loop of update_schedule_item did,
        // and the write-ledger captures one clean pre-image for undo.
        shift_schedule_items(args) {
            const plan = AgentTools._shiftPlan(args);
            if (plan.error) return plan;

            const data = StorageManager.get('schedule') || {};
            const items = data.scheduleItems || [];
            const ids = new Set(plan.items.map(t => t.id));
            let count = 0;
            for (const it of items) {
                if (!ids.has(it.id)) continue;
                // collapse: each task's own distance to the anchor; otherwise
                // the plan's one delta for all.
                const delta = plan.collapseTo ? daysBetweenISO(it.scheduledDate, plan.collapseTo) : plan.delta;
                // Weekly/custom recurrences key on stored weekday numbers, not
                // the anchor date (ScheduleApp.repeatsOnDay) — carry them so the
                // pattern moves with the anchor when the shift breaks weekdays.
                const dowShift = ((delta % 7) + 7) % 7;
                it.scheduledDate = addDaysISO(it.scheduledDate, delta);
                if (dowShift) {
                    if (it.repeat === 'weekly' && typeof it.dayOfWeek === 'number') {
                        it.dayOfWeek = (it.dayOfWeek + dowShift) % 7;
                    }
                    if (it.repeat === 'custom' && Array.isArray(it.repeatDays)) {
                        it.repeatDays = it.repeatDays.map(d => (d + dowShift) % 7);
                    }
                }
                count++;
            }
            // Spread preserves the rest of the blob (emailActionLedger —
            // same care as update_schedule_item).
            StorageManager.set('schedule', { ...data, scheduleItems: items });
            AgentTools.refreshApp('schedule');

            const overshoot = plan.goal && plan.goal.targetDate && plan.lastAfter > plan.goal.targetDate;
            return {
                success: true, count,
                ...(plan.collapseTo ? { landedOn: plan.collapseTo } : { shiftedDays: plan.delta }),
                ...(plan.goal ? { goal: { id: plan.goal.id, title: plan.goal.title } } : {}),
                firstDate: plan.firstAfter, lastDate: plan.lastAfter,
                ...(plan.undatedCount ? { undatedLeftInPlace: plan.undatedCount } : {}),
                ...(plan.missingIds ? { unknownIds: plan.missingIds } : {}),
                ...(overshoot ? { note: `The last task now lands ${plan.lastAfter}, after the project's target date ${plan.goal.targetDate} — offer to move the project's target with update_goal.` } : {})
            };
        },

        create_note(args) {
            // C8.1's truncation ladder falls back to {} args after a failed
            // retry, counting on tool validation to catch it — an empty
            // Untitled note is a silent wrong write, not a note.
            if (!String(args?.title || '').trim() && !String(args?.content || '').trim()) {
                return { error: 'create_note needs a title and content — the call arrived empty (it may have been cut off). Re-issue it with less content.' };
            }
            const data = StorageManager.get('notes') || {};
            const notes = data.notes || [];
            const now = new Date().toISOString();

            const newNote = {
                id: UIUtils.generateId(),
                title: args.title,
                content: AgentTools.mdToNoteHtml(args.content),
                tags: args.tags || [],
                // Provenance type: assistant-written notes carry the
                // 'assistant' template (chip on the card, sidebar filter).
                template: 'assistant',
                pinned: false,
                createdAt: now,
                modifiedAt: now
            };

            notes.unshift(newNote);
            StorageManager.set('notes', { notes });
            AgentTools.refreshApp('notes');

            return { success: true, note: { id: newNote.id, title: newNote.title } };
        },

        // ── ACTIONS ──

        complete_task(args) {
            const data = StorageManager.get('schedule') || {};
            const items = data.scheduleItems || [];
            // Search within the ACTIVE profile only (consistent with
            // delete_schedule_item and every schedule view) so we never
            // complete a same-named task in another profile while the one the
            // user is looking at stays open. The filtered array holds the same
            // object references as `items`, so mutating the match updates the
            // array we persist.
            const visible = items;
            const item = AgentTools.findBySearchOrId(visible, args.search, args.id);
            if (!item) return { error: `Task not found matching "${args.search || args.id}" in the active profile.` };

            const today = getDateStr(0);
            item.history = (item.history && typeof item.history === 'object') ? item.history : {};
            if (args.abandon) {
                // Abandoned = deliberately not done. Same semantics as the
                // editor's toggleAbandoned: resolves the task with the honest
                // label, replacing a same-day completion.
                item.history[today] = 'abandoned';
                if (item.lastCompletedDate === today) item.lastCompletedDate = null;
                item.modifiedAt = new Date().toISOString();
            } else {
                // Both one-time and repeating tasks record completion as "done on
                // this date"; the schedule reads lastCompletedDate for done-state.
                item.lastCompletedDate = today;
                item.history[today] = 'done';
                // Completing clears abandoned marks on one-time tasks so the
                // task can't read as both at once (mirrors toggleComplete).
                if (!item.repeat || item.repeat === 'none') {
                    for (const d of Object.keys(item.history)) {
                        if (item.history[d] === 'abandoned') delete item.history[d];
                    }
                }
            }

            // Preserve the rest of the schedule blob — notably emailActionLedger,
            // which stops deleted email-derived tasks from resurrecting on the
            // next email sync. A bare { scheduleItems } write would drop it.
            StorageManager.set('schedule', { ...data, scheduleItems: items });
            AgentTools.refreshApp('schedule');

            // Echo the description so the model sees, right after acting, any
            // parts of the task the user didn't mention — its chance to catch
            // a partial completion ("that task also included X") and offer to
            // reopen instead of silently resolving a multi-part task.
            const echo = { id: item.id, title: item.title };
            if (item.description) echo.description = item.description;
            return args.abandon
                ? { success: true, item: { ...echo, status: 'abandoned', abandonedDate: today } }
                : { success: true, item: { ...echo, completedDate: item.lastCompletedDate } };
        },

        delete_schedule_item(args) {
            // ── Safety guardrails ──────────────────────────────────────────
            // 1. Must have either a search string or an id
            // 2. Search string must be specific (>= 3 non-whitespace chars)
            //    to avoid matching too many items by accident
            // 3. Search must resolve to exactly one item in the active profile;
            //    if it's ambiguous we refuse and return candidates so the agent
            //    must call again with a more specific search or an exact id
            // 4. id, when provided, must match an item in the active profile
            //    (prevents cross-profile deletion via guessed ids)
            const search = (args.search || '').trim();
            const id = args.id || null;

            if (!id && !search) {
                return { error: 'delete_schedule_item requires either "search" or "id".' };
            }
            if (!id && search.length < 3) {
                return { error: `Search "${search}" is too short (minimum 3 characters). Use a more specific title or pass an id.` };
            }

            const data = StorageManager.get('schedule') || {};
            const items = data.scheduleItems || [];
            // Only operate on items visible to the current profile
            const visible = items;

            let target = null;
            if (id) {
                target = visible.find(i => i.id === id);
                if (!target) {
                    return { error: `No schedule item with id "${id}" in the active profile.` };
                }
            } else {
                const q = search.toLowerCase();
                // Prefer exact (case-insensitive) title match — always unambiguous
                const exactMatches = visible.filter(i => (i.title || '').toLowerCase() === q);
                if (exactMatches.length === 1) {
                    target = exactMatches[0];
                } else if (exactMatches.length > 1) {
                    return {
                        error: `Search "${search}" matches ${exactMatches.length} items with the exact same title. Pass an explicit id to disambiguate.`,
                        candidates: exactMatches.map(i => ({ id: i.id, title: i.title, startTime: i.startTime, scheduledDate: i.scheduledDate }))
                    };
                } else {
                    // Fall back to substring match — but require uniqueness
                    const partialMatches = visible.filter(i => (i.title || '').toLowerCase().includes(q));
                    if (partialMatches.length === 0) {
                        return { error: `No schedule item found matching "${search}".` };
                    }
                    if (partialMatches.length > 1) {
                        return {
                            error: `Search "${search}" is ambiguous — it matches ${partialMatches.length} items. Retry with a more specific search or pass an explicit id from the candidates.`,
                            candidates: partialMatches.slice(0, 10).map(i => ({ id: i.id, title: i.title, startTime: i.startTime, scheduledDate: i.scheduledDate }))
                        };
                    }
                    target = partialMatches[0];
                }
            }

            // Capture details before mutation so we can echo them back
            const deleted = {
                id: target.id,
                title: target.title,
                startTime: target.startTime,
                endTime: target.endTime,
                scheduledDate: target.scheduledDate,
                repeat: target.repeat
            };

            // Mirror ScheduleApp.deleteCurrentItem(): drop links, then drop the item
            LinkManager.removeAllLinksForItem('schedule', target.id);
            const remaining = items.filter(i => i.id !== target.id);
            StorageManager.set('schedule', { ...data, scheduleItems: remaining });
            AgentTools.refreshApp('schedule');

            return { success: true, deleted };
        },

        // ── EMAIL handlers ──────────────────────────────────────────────────

        async list_emails(args) {
            if (typeof EmailApp === 'undefined') return { error: 'Inbox app not loaded.' };
            const { pool, folder, coverage } = await AgentTools._filterEmails(args);

            const limit = Math.min(Math.max(parseInt(args.limit) || 20, 1), 100);
            const sliced = pool.slice(0, limit);

            return {
                folder,
                total: pool.length,
                returned: sliced.length,
                coverage,
                coverageNote: 'Only locally synced mail is searched. For anything older than oldestSyncedMail, confirm the timeframe with the user and call sync_older_emails first.',
                emails: sliced.map(e => ({
                    id: e.messageId,
                    from: e.from,
                    subject: e.subject,
                    snippet: e.snippet,
                    date: e.date,
                    isRead: !!e.isRead,
                    account: e.account
                }))
            };
        },

        /**
         * Bulk extraction: filter emails, then run one capped structured
         * LLM read per match and return a single table. The "map" half of
         * review-all-my-emails jobs, done in a controlled loop instead of
         * the agent burning its tool budget on get_email round-trips.
         */
        async scan_emails(args) {
            if (typeof EmailApp === 'undefined') return { error: 'Inbox app not loaded.' };
            const instruction = String(args?.instruction || '').trim();
            const fields = (Array.isArray(args?.fields) ? args.fields : [])
                .map(f => String(f).trim()).filter(Boolean).slice(0, 12);
            if (!instruction) return { error: 'instruction required' };
            if (!fields.length) return { error: 'fields required (array of column names)' };

            const { pool, coverage } = await AgentTools._filterEmails({ ...args, folder: args.folder || 'all' });
            const limit = Math.min(Math.max(parseInt(args.limit) || 50, 1), 200);
            const toScan = pool.slice(0, limit);
            if (!toScan.length) return { matchedFilter: 0, scanned: 0, rows: [], coverage };

            const status = (text) => {
                try { if (typeof AgentUI !== 'undefined') AgentUI.setToolStatus(text); } catch { /* display only */ }
            };
            const TIME_BUDGET_MS = 10 * 60 * 1000;
            const startedAt = Date.now();
            const rows = [];
            let scanned = 0, failures = 0, stoppedEarly = null;

            for (const email of toScan) {
                if (Date.now() - startedAt > TIME_BUDGET_MS) {
                    stoppedEarly = 'Stopped at the 10-minute budget.';
                    break;
                }
                if (failures >= 8 && rows.length === 0) {
                    stoppedEarly = 'Stopped: the model kept returning unusable output.';
                    break;
                }
                scanned++;
                status(`Scanning emails… ${scanned}/${toScan.length}${rows.length ? ` (${rows.length} extracted)` : ''}`);
                try {
                    await EmailApp._ensureBody(email);
                    let body = email.bodyText || '';
                    if (!body && email.bodyHtml) body = email.bodyHtml.replace(/<[^>]+>/g, ' ');
                    body = (body || email.snippet || '').replace(/\s+/g, ' ').trim().slice(0, 3500);

                    // Same treatment as the other background email reads:
                    // JSON-constrained, small cap, no reasoning block.
                    const result = await LLMLogger.call('email', {
                        model: AgentService.model,
                        format: 'json',
                        maxTokens: 400,
                        think: false,
                        messages: [
                            { role: 'system', content:
`You extract structured data from ONE email.
Task: ${instruction}
Fields: ${fields.join(', ')}
Respond ONLY with JSON exactly like: {"relevant": true, "data": {${fields.map(f => `"${f}": null`).join(', ')}}}
Set relevant to false when the email does not contain what the task asks for. Use null for any field you cannot determine.` },
                            { role: 'user', content: `From: ${email.from}\nSubject: ${email.subject}\nDate: ${email.date}\n\n${body}` }
                        ],
                        stream: false
                    });

                    const content = result?.message?.content || '';
                    const jsonMatch = content.match(/\{[\s\S]*\}/);
                    const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
                    if (!parsed) { failures++; continue; }
                    if (parsed.relevant === false) continue;

                    const data = (parsed.data && typeof parsed.data === 'object') ? parsed.data : {};
                    const d = new Date(email.date || 0);
                    const row = {
                        id: email.messageId,
                        date: isNaN(d) ? (email.date || null) : d.toISOString().slice(0, 10),
                        from: String(email.from || '').replace(/<[^>]*>/g, '').replace(/"/g, '').trim().slice(0, 40),
                        subject: String(email.subject || '').slice(0, 80)
                    };
                    for (const f of fields) {
                        const v = data[f];
                        row[f] = typeof v === 'string' ? v.slice(0, 200) : (v ?? null);
                    }
                    rows.push(row);
                } catch {
                    failures++;
                }
            }
            status('');

            return {
                matchedFilter: pool.length,
                scanned,
                extractedRows: rows.length,
                failures,
                rows,
                coverage,
                ...(pool.length > limit ? {
                    note: `The filter matched ${pool.length} emails but only the newest ${limit} were scanned. Narrow with from/after/before, or page older mail with before=<oldest scanned date>.`
                } : {}),
                ...(stoppedEarly ? { stoppedEarly } : {})
            };
        },

        /**
         * Extend local history from Gmail's servers back to until_date.
         * Deliberately capped per call so a runaway range can't grind
         * forever; the result says plainly whether it's done.
         */
        async sync_older_emails(args) {
            if (typeof EmailApp === 'undefined') return { error: 'Inbox app not loaded.' };
            const until = Date.parse(String(args?.until_date || '') + 'T00:00:00');
            if (isNaN(until)) return { error: 'until_date (YYYY-MM-DD) required' };
            EmailApp.loadData();

            let accounts = EmailApp.getAccounts().filter(a => !EmailApp._isDemoAccount(a));
            if (args.account) {
                const want = String(args.account).toLowerCase();
                accounts = accounts.filter(a => a.email.toLowerCase() === want);
            }
            if (!accounts.length) return { error: 'No matching connected account.' };

            const MAX_ROUNDS = 20; // ≤2000 messages per account per call
            const results = [];
            for (const account of accounts) {
                let fetched = 0, rounds = 0, error = null;
                while (rounds < MAX_ROUNDS) {
                    if (EmailApp.backfillDone[account.email]) break;
                    const oldest = EmailApp._oldestEmailTs(account.email);
                    if (oldest && oldest <= until) break;
                    const options = { maxResults: 100 };
                    if (oldest) options.beforeTs = oldest / 1000;
                    const result = await EmailApp._fetchEmails(account.email, options);
                    if (result?.error) { error = result.error; break; }
                    const batch = result?.emails || [];
                    if (batch.length === 0) {
                        EmailApp.backfillDone[account.email] = true;
                        break;
                    }
                    const toPersist = [];
                    for (const email of batch) {
                        const idx = EmailApp.emails.findIndex(e => e.messageId === email.messageId);
                        if (idx >= 0) {
                            EmailApp.emails[idx] = { ...EmailApp.emails[idx], ...email };
                            toPersist.push(EmailApp.emails[idx]);
                        } else {
                            EmailApp.emails.push(email);
                            toPersist.push(email);
                            fetched++;
                        }
                    }
                    await EmailApp._persistEmails(toPersist);
                    rounds++;
                }
                const oldestNow = EmailApp._oldestEmailTs(account.email);
                const reachedTarget = !!EmailApp.backfillDone[account.email] || (oldestNow != null && oldestNow <= until);
                results.push({
                    account: account.email,
                    fetched,
                    oldestSyncedMail: oldestNow ? new Date(oldestNow).toISOString().slice(0, 10) : null,
                    reachedTarget,
                    ...(error ? { error } : {}),
                    ...(!reachedTarget && !error && rounds >= MAX_ROUNDS
                        ? { note: 'Stopped at the per-call cap. Call sync_older_emails again with the same until_date to continue.' }
                        : {})
                });
            }
            EmailApp.saveData();
            if (typeof AppManager !== 'undefined' && AppManager.currentApp === 'email') {
                try { EmailApp.render(); } catch { /* display must not fail the tool */ }
            }
            return { results };
        },

        async get_email(args, ctx) {
            if (typeof EmailApp === 'undefined') return { error: 'Inbox app not loaded.' };
            if (!args.id) return { error: 'get_email requires "id".' };
            EmailApp.loadData();

            const pool = EmailApp.getProfileEmails() || [];
            const email = pool.find(e => e.messageId === args.id);
            if (!email) {
                return { error: `No email with id "${args.id}" in the active profile.` };
            }

            // Bodies live in a separate SQLite table and are not loaded with
            // the list — fetch on demand or every body reads as empty.
            await EmailApp._ensureBody(email);
            // Same for attachment metadata on messages synced before the
            // field existed. Without this the model is never told a PDF is
            // there and answers as if the mail were self-contained — which
            // is how an invoice whose due date lives in the attachment got
            // a made-up one.
            if (typeof EmailApp._ensureAttachmentsMeta === 'function') {
                try { await EmailApp._ensureAttachmentsMeta(email); } catch { /* metadata is best-effort */ }
            }
            const attachments = (email.attachments || []).map(a => ({
                filename: a.filename,
                mimeType: a.mimeType,
                size: a.size,
                attachmentId: a.attachmentId
            }));

            // Strip the body to plain text — agents don't need HTML and it bloats context
            const body = email.bodyText
                || (email.bodyHtml || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
                || email.snippet || '';

            // Images (2026-08-26): the pictures ARE the content of a great
            // many emails — a screenshot of a bill, a flyer, a pasted
            // receipt — and the model used to read those as empty. When the
            // turn's model can see, every inline image and image attachment
            // rides the result as a vision payload (the fs_read / MCP
            // screenshot contract: `images` is lifted into image parts by
            // the agent loop, never left as base64 in the tool JSON). When
            // it can't, the list below still names them so the model can
            // say what it could not read instead of guessing.
            const imageAtts = attachments.filter(a => /^image\/(png|jpe?g|webp|gif)$/i.test(String(a.mimeType || '')));
            const canSee = typeof AgentService !== 'undefined' && typeof AgentService.supportsVision === 'function'
                && AgentService.supportsVision(AgentService.getActiveEntry(ctx && ctx.convId));
            const images = [];
            const imageNotes = [];
            if (imageAtts.length && canSee && args.images !== false && window.electronEmail?.readAttachmentText) {
                const MAX_IMAGES = 6;
                const MAX_TOTAL = 12 * 1024 * 1024;
                let total = 0;
                for (const a of imageAtts.slice(0, MAX_IMAGES)) {
                    if ((a.size || 0) > 8 * 1024 * 1024 || total + (a.size || 0) > MAX_TOTAL) { imageNotes.push(`${a.filename} skipped (too large)`); continue; }
                    try {
                        const r = await window.electronEmail.readAttachmentText({
                            account: email.account, messageId: email.messageId,
                            attachmentId: a.attachmentId, filename: a.filename, mimeType: a.mimeType
                        });
                        if (r && !r.error && Array.isArray(r.images) && r.images.length) {
                            images.push(...r.images);
                            total += a.size || 0;
                        } else if (r?.error) imageNotes.push(`${a.filename}: ${r.error}`);
                    } catch (e) { imageNotes.push(`${a.filename}: ${e?.message || 'fetch failed'}`); }
                }
                if (imageAtts.length > MAX_IMAGES) imageNotes.push(`${imageAtts.length - MAX_IMAGES} more image(s) not attached — read them one at a time with read_email_attachment`);
            }
            const otherAtts = attachments.filter(a => !imageAtts.includes(a));

            const out = {
                id: email.messageId,
                threadId: email.threadId,
                account: email.account,
                from: email.from,
                to: email.to,
                cc: email.cc,
                subject: email.subject,
                date: email.date,
                isRead: !!email.isRead,
                labels: email.labels || [],
                body: body,
                ...(attachments.length ? {
                    attachments,
                    ...(otherAtts.length ? { attachmentNote: 'This email has attachments. Their CONTENTS are not in the body above — call read_email_attachment with this email id and the attachmentId to read one. When the answer depends on what the attachment says (an invoice amount, a due date, a statement total), read it rather than inferring from the body.' } : {})
                } : {}),
                ...(imageAtts.length ? {
                    imageNote: images.length
                        ? `${images.length} image(s) from this email (${imageAtts.filter(a => a.inline).length} inline) are attached below this result — read them as part of the email's content.`
                        : (canSee
                            ? 'This email contains images that could not be fetched.'
                            : 'This email contains images (listed in attachments), which the current model cannot view — tell the user which content you could not read rather than guessing; a vision-capable model can read them.'),
                    ...(imageNotes.length ? { imageIssues: imageNotes } : {})
                } : {}),
                ...(body || images.length ? {} : {
                    note: 'No body is stored locally for this message (only headers/snippet synced). Tell the user to open it in the Inbox app; do not try to reach Gmail another way.'
                })
            };

            // Page the body inside the 6k result budget (the read_note mould,
            // sized dynamically because headers/attachments vary) — otherwise
            // the agent-service hard-trim cuts the JSON mid-record and there
            // is no way to ask for the tail.
            const start = Math.max(0, parseInt(args.offset, 10) || 0);
            const overhead = JSON.stringify({ ...out, body: '' }).length;
            let slice = body.slice(start, start + Math.max(1000, 5600 - overhead));
            out.body = slice;
            // JSON escaping can inflate the stringified body past the budget
            while (slice.length > 500 && JSON.stringify(out).length > 5800) {
                slice = slice.slice(0, Math.floor(slice.length * 0.9));
                out.body = slice;
            }
            if (start > 0 || start + slice.length < body.length) {
                out.offset = start;
                out.totalChars = body.length;
                out.truncated = start + slice.length < body.length;
                if (out.truncated) {
                    out.bodyNote = `Body is ${body.length} chars; showing ${slice.length} from offset ${start}. Call get_email again with offset ${start + slice.length} to continue.`;
                }
            }
            // Added AFTER the size loop: the agent loop strips `images`
            // before stringifying, so they never count against the budget.
            if (images.length && start === 0) out.images = images;
            return out;
        },

        /**
         * C10 follow-up (2026-08-03): the agent could not see attachments at
         * all — get_email returned headers and body text only, so a routine
         * asked to pull a due date out of an attached invoice had no way to
         * do it and would invent one instead. Everything needed already
         * existed (pdf.js + Vision OCR in main, the Gmail attachment fetch);
         * only the tool surface was missing.
         */
        async read_email_attachment(args) {
            if (typeof EmailApp === 'undefined') return { error: 'Inbox app not loaded.' };
            if (!args?.id) return { error: 'read_email_attachment requires "id" (the email id).' };
            if (!window.electronEmail?.readAttachmentText) {
                return { error: 'Attachment reading is unavailable in this build.' };
            }
            EmailApp.loadData();
            const email = (EmailApp.getProfileEmails() || []).find(e => e.messageId === args.id);
            if (!email) return { error: `No email with id "${args.id}".` };

            if (typeof EmailApp._ensureAttachmentsMeta === 'function') {
                try { await EmailApp._ensureAttachmentsMeta(email); } catch { /* best-effort */ }
            }
            const list = email.attachments || [];
            if (!list.length) return { error: 'That email has no attachments.' };

            // Resolve by attachmentId, else by filename, else — when there is
            // exactly one — just take it. A model that read get_email's
            // output usually has the id; one that guessed the filename
            // shouldn't fail for a spelling difference.
            let att = null;
            if (args.attachmentId) att = list.find(a => a.attachmentId === args.attachmentId);
            if (!att && args.filename) {
                const want = String(args.filename).toLowerCase();
                att = list.find(a => String(a.filename || '').toLowerCase() === want)
                    || list.find(a => String(a.filename || '').toLowerCase().includes(want));
            }
            if (!att && list.length === 1) att = list[0];
            if (!att) {
                return {
                    error: 'Could not tell which attachment to read.',
                    attachments: list.map(a => ({ filename: a.filename, attachmentId: a.attachmentId }))
                };
            }

            const res = await window.electronEmail.readAttachmentText({
                account: email.account,
                messageId: email.messageId,
                attachmentId: att.attachmentId,
                filename: att.filename,
                mimeType: att.mimeType
            });
            if (res?.error) return { error: res.error, filename: att.filename };

            if (res?.kind === 'image' && Array.isArray(res.images)) {
                return { filename: res.name || att.filename, kind: 'image', images: res.images, note: res.note };
            }

            const text = String(res.text || '');
            const CAP = 20000;
            return {
                filename: res.name || att.filename,
                kind: res.kind,
                ...(res.pages ? { pages: res.pages } : {}),
                ...(res.ocr ? { ocr: true, note: 'This was a scanned document read by OCR — treat unusual characters as scan noise.' } : {}),
                text: text.length > CAP ? text.slice(0, CAP) + '\n…(truncated)' : text,
                truncated: text.length > CAP
            };
        },

        list_email_analyses(args) {
            if (typeof EmailApp === 'undefined') return { error: 'Inbox app not loaded.' };
            EmailApp.loadData();

            const analyses = EmailApp.getProfileAnalyses() || {};
            const emails = EmailApp.getProfileEmails() || [];
            const emailById = new Map(emails.map(e => [e.messageId, e]));

            const unreadOnly = args.unread_only !== false;
            const limit = Math.min(Math.max(parseInt(args.limit) || 20, 1), 100);

            const rows = Object.entries(analyses)
                .filter(([emailId, a]) => {
                    if (unreadOnly && a.readAt) return false;
                    return emailById.has(emailId);
                })
                .map(([emailId, a]) => {
                    const e = emailById.get(emailId);
                    return {
                        emailId,
                        from: e?.from,
                        subject: e?.subject,
                        priority: a.priority,
                        summary: a.summary,
                        actionItems: a.actionItems || [],
                        insights: a.insights || [],
                        analyzedAt: a.analyzedAt,
                        readAt: a.readAt || null
                    };
                })
                .sort((a, b) => new Date(b.analyzedAt || 0) - new Date(a.analyzedAt || 0))
                .slice(0, limit);

            return { total: rows.length, analyses: rows };
        },

        async mark_email_read(args) {
            if (typeof EmailApp === 'undefined') return { error: 'Inbox app not loaded.' };
            if (!args.id) return { error: 'mark_email_read requires "id".' };
            EmailApp.loadData();

            const email = (EmailApp.getProfileEmails() || []).find(e => e.messageId === args.id);
            if (!email) return { error: `No email with id "${args.id}" in the active profile.` };

            const read = args.read !== false; // default true
            email.isRead = read;
            email.labels = email.labels || [];
            if (read) {
                email.labels = email.labels.filter(l => l !== 'UNREAD');
            } else if (!email.labels.includes('UNREAD')) {
                email.labels.push('UNREAD');
            }
            EmailApp.saveData();
            AgentTools.refreshApp('email');

            if (email.account) {
                const result = read
                    ? await window.electronEmail.markRead(email.account, email.messageId)
                    : await window.electronEmail.modifyLabels(email.account, email.messageId, ['UNREAD'], []);
                if (result?.error) {
                    return { success: false, error: `Local state updated but Gmail update failed: ${result.error}`, needsReconnect: !!result.needsReconnect };
                }
            }
            return { success: true, id: email.messageId, isRead: read };
        },

        async archive_email(args) {
            if (typeof EmailApp === 'undefined') return { error: 'Inbox app not loaded.' };
            if (!args.id) return { error: 'archive_email requires "id".' };
            EmailApp.loadData();

            const email = (EmailApp.getProfileEmails() || []).find(e => e.messageId === args.id);
            if (!email) return { error: `No email with id "${args.id}" in the active profile.` };

            // Mirror EmailApp.archiveCurrentEmail()
            email.labels = (email.labels || []).filter(l => l !== 'INBOX');
            if (!email.labels.includes('ARCHIVE')) email.labels.push('ARCHIVE');
            EmailApp.saveData();
            AgentTools.refreshApp('email');

            if (email.account) {
                const result = await window.electronEmail.modifyLabels(email.account, email.messageId, [], ['INBOX']);
                if (result?.error) {
                    return { success: false, error: `Local state updated but Gmail archive failed: ${result.error}`, needsReconnect: !!result.needsReconnect };
                }
            }
            return { success: true, archived: { id: email.messageId, subject: email.subject, from: email.from } };
        },


        async trash_email(args) {
            if (typeof EmailApp === 'undefined') return { error: 'Inbox app not loaded.' };
            if (!args.id) return { error: 'trash_email requires "id".' };
            EmailApp.loadData();

            const email = (EmailApp.getProfileEmails() || []).find(e => e.messageId === args.id);
            if (!email) return { error: `No email with id "${args.id}" in the active profile.` };

            // Capture details before mutation so we can echo back
            const trashed = { id: email.messageId, subject: email.subject, from: email.from, account: email.account };

            // Mirror EmailApp.trashCurrentEmail()
            email.labels = ['TRASH'];
            EmailApp.saveData();
            AgentTools.refreshApp('email');

            if (email.account) {
                const result = await window.electronEmail.trash(email.account, email.messageId);
                if (result?.error) {
                    return { success: false, error: `Local state updated but Gmail trash failed: ${result.error}`, needsReconnect: !!result.needsReconnect };
                }
            }
            return { success: true, trashed };
        },

        async send_email(args) {
            if (typeof EmailApp === 'undefined') return { error: 'Inbox app not loaded.' };
            EmailApp.loadData();

            // Resolve account: explicit > inferred from replyToId > single profile account
            let account = null;
            let originalEmail = null;

            if (args.replyToId) {
                originalEmail = (EmailApp.getProfileEmails() || []).find(e => e.messageId === args.replyToId);
                if (!originalEmail) {
                    return { error: `replyToId "${args.replyToId}" does not match any email in the active profile.` };
                }
                if (!args.account) account = originalEmail.account;
            }

            if (!account) {
                const resolved = AgentTools.resolveEmailAccount(args.account);
                if (resolved.error) return resolved;
                account = resolved.account.email;
            } else if (args.account) {
                // explicit account override — verify it's connected
                const resolved = AgentTools.resolveEmailAccount(args.account);
                if (resolved.error) return resolved;
                account = resolved.account.email;
            }

            // Derive to / subject for replies
            let to = args.to;
            let subject = args.subject;
            if (originalEmail) {
                if (!to) to = originalEmail.from;
                if (!subject) {
                    const orig = originalEmail.subject || '';
                    subject = /^re:/i.test(orig) ? orig : `Re: ${orig}`;
                }
            }

            // Validate required fields
            if (!to || !String(to).trim()) {
                return { error: 'send_email requires "to" (or a valid replyToId so it can be inferred).' };
            }
            if (!String(args.body || '').trim()) {
                return { error: 'send_email requires a non-empty "body".' };
            }
            if (!subject) subject = '(no subject)';

            const params = {
                to: String(to).trim(),
                cc: args.cc ? String(args.cc).trim() : '',
                bcc: args.bcc ? String(args.bcc).trim() : '',
                subject,
                body: AgentTools.plainTextBodyToHtml(args.body)
            };

            if (originalEmail) {
                if (originalEmail.messageIdHeader) {
                    params.inReplyTo = originalEmail.messageIdHeader;
                    params.references = originalEmail.messageIdHeader;
                }
                if (originalEmail.threadId) params.threadId = originalEmail.threadId;
            }

            const result = await window.electronEmail.sendEmail(account, params);
            if (result?.error) {
                return { success: false, error: `Send failed: ${result.error}`, needsReconnect: !!result.needsReconnect };
            }

            // Mirror EmailApp.sendCompose() bookkeeping: save contacts, add to priority senders
            for (const addr of [params.to, params.cc, params.bcc].join(',').split(',')) {
                const trimmed = addr.trim();
                if (trimmed && trimmed.includes('@')) {
                    EmailApp.addContact?.(trimmed, '');
                    EmailApp.addPrioritySenderIfNew?.(trimmed);
                }
            }
            EmailApp.saveData();
            // Resync after a short delay so the sent message lands in the local cache
            setTimeout(() => EmailApp.syncEmails?.(), 1500);
            AgentTools.refreshApp('email');

            return {
                success: true,
                sent: {
                    from: account,
                    to: params.to,
                    cc: params.cc || undefined,
                    bcc: params.bcc || undefined,
                    subject: params.subject,
                    messageId: result.messageId,
                    threadId: result.threadId,
                    isReply: !!originalEmail
                }
            };
        },

        mark_analysis_read(args) {
            if (typeof EmailApp === 'undefined') return { error: 'Inbox app not loaded.' };
            if (!args.emailId) return { error: 'mark_analysis_read requires "emailId".' };
            EmailApp.loadData();

            const analyses = EmailApp.priorityAnalyses || {};
            const a = analyses[args.emailId];
            if (!a) return { error: `No analysis exists for emailId "${args.emailId}".` };

            const read = args.read !== false;
            EmailApp.markAnalysisRead?.(args.emailId, read);
            AgentTools.refreshApp('email');

            return { success: true, emailId: args.emailId, read };
        },

        // ── CALENDAR handlers ───────────────────────────────────────────────

        async list_calendar_events(args) {
            if (typeof CalendarApp === 'undefined') return { error: 'Calendar app not loaded.' };
            CalendarApp.loadData();
            // Pull from Google when the cache is stale so "what's on my
            // calendar" reflects Google right now, not the last timer tick.
            // A failed sync still answers from the cache (syncEvents toasts
            // on its own).
            try { await CalendarApp.syncIfStale?.(2 * 60 * 1000); } catch { /* cache fallback */ }

            // Resolve range
            const parseDate = (s, fallback) => {
                if (!s) return fallback;
                if (s === 'today') return getDateStr(0);
                if (s === 'tomorrow') return getDateStr(1);
                if (s === 'yesterday') return getDateStr(-1);
                return s; // assume YYYY-MM-DD
            };
            const fromStr = parseDate(args.from, getDateStr(0));
            const toStr = parseDate(args.to, fromStr);
            const fromTs = new Date(`${fromStr}T00:00:00`).getTime();
            const toTs = new Date(`${toStr}T23:59:59.999`).getTime();

            // Filter to active-profile accounts
            const accountEmails = new Set((CalendarApp.getAccounts() || []).map(a => a.email));
            let events = (CalendarApp.events || []).filter(e => accountEmails.has(e.account));

            // Time window
            events = events.filter(e => {
                const start = e.start instanceof Date ? e.start.getTime() : new Date(e.start).getTime();
                return start >= fromTs && start <= toTs;
            });

            // Query filter
            if (args.query) {
                const q = String(args.query).toLowerCase();
                events = events.filter(e =>
                    (e.summary || '').toLowerCase().includes(q) ||
                    (e.location || '').toLowerCase().includes(q) ||
                    (e.description || '').toLowerCase().includes(q)
                );
            }

            events.sort((a, b) => {
                const sa = a.start instanceof Date ? a.start.getTime() : new Date(a.start).getTime();
                const sb = b.start instanceof Date ? b.start.getTime() : new Date(b.start).getTime();
                return sa - sb;
            });

            const limit = Math.min(Math.max(parseInt(args.limit) || 50, 1), 200);
            const sliced = events.slice(0, limit);

            return {
                from: fromStr,
                to: toStr,
                total: events.length,
                returned: sliced.length,
                events: sliced.map(e => ({
                    id: e.id,
                    summary: e.summary,
                    start: e.start instanceof Date ? e.start.toISOString() : e.start,
                    end: e.end instanceof Date ? e.end.toISOString() : e.end,
                    allDay: !!e.allDay,
                    location: e.location || undefined,
                    description: e.description || undefined,
                    account: e.account,
                    calendarId: e.calendarId,
                    recurringEventId: e.recurringEventId || undefined
                }))
            };
        },

        async create_calendar_event(args) {
            if (typeof CalendarApp === 'undefined') return { error: 'Calendar app not loaded.' };
            if (!args.summary || !String(args.summary).trim()) {
                return { error: 'create_calendar_event requires "summary".' };
            }
            if (!args.start) return { error: 'create_calendar_event requires "start".' };

            const resolved = AgentTools.resolveCalendarAccount(args.account);
            if (resolved.error) return resolved;
            const account = resolved.account.email;

            // Build start / end objects in the shape Google Calendar expects.
            // For timed events we always pair the dateTime with an explicit timeZone
            // so a naive ISO string like "2026-04-10T18:00:00" can't be silently
            // reinterpreted as UTC (which would land 4-8 hours off the wall clock).
            const tz = (typeof Intl !== 'undefined' && Intl.DateTimeFormat)
                ? Intl.DateTimeFormat().resolvedOptions().timeZone
                : null;

            const allDay = !!args.all_day;
            let startObj, endObj;
            try {
                if (allDay) {
                    const startDate = String(args.start).slice(0, 10);
                    const endDate = args.end ? String(args.end).slice(0, 10) : startDate;
                    startObj = { date: startDate };
                    endObj = { date: endDate };
                } else {
                    const startInfo = AgentTools.parseAgentDateTime(args.start);
                    if (startInfo.error) return { error: `Invalid "start" value: ${startInfo.error}` };
                    let endIso;
                    if (args.end) {
                        const endInfo = AgentTools.parseAgentDateTime(args.end);
                        if (endInfo.error) return { error: `Invalid "end" value: ${endInfo.error}` };
                        endIso = endInfo.iso;
                    } else {
                        // Default duration: 1 hour after start, computed in local time
                        // (so we don't introduce a UTC round-trip on the wall-clock value)
                        const startLocal = new Date(startInfo.iso);
                        const endLocal = new Date(startLocal.getTime() + 60 * 60 * 1000);
                        const pad = (n) => String(n).padStart(2, '0');
                        endIso = `${endLocal.getFullYear()}-${pad(endLocal.getMonth() + 1)}-${pad(endLocal.getDate())}T${pad(endLocal.getHours())}:${pad(endLocal.getMinutes())}:${pad(endLocal.getSeconds())}`;
                    }
                    startObj = { dateTime: startInfo.iso };
                    endObj = { dateTime: endIso };
                    if (tz) {
                        startObj.timeZone = tz;
                        endObj.timeZone = tz;
                    }
                }
            } catch (e) {
                return { error: `Could not parse start/end: ${e.message}` };
            }

            const eventData = {
                summary: String(args.summary).trim(),
                description: args.description || '',
                location: args.location || '',
                start: startObj,
                end: endObj
            };
            if (Array.isArray(args.attendees) && args.attendees.length) {
                eventData.attendees = args.attendees.map(email => ({ email }));
            }

            const result = await window.electronCalendar.createEvent(account, 'primary', eventData);

            // Match the existing CalendarApp.saveEvent success check: require either
            // an explicit success flag or a returned event object. Anything else (no
            // error key, no event, no success) means something went wrong silently.
            if (result?.error) {
                return { success: false, error: `Create failed: ${result.error}`, needsReconnect: !!result.needsReconnect };
            }
            if (!result?.success && !result?.event) {
                return { success: false, error: `Create did not return a confirmation event. Raw response: ${JSON.stringify(result)}` };
            }

            const newId = result.event?.id;

            // Verify the event actually landed by re-syncing and looking it up
            try { await CalendarApp.syncEvents?.(); } catch (e) { /* sync errors handled in syncEvents */ }
            AgentTools.refreshApp('calendar');

            const verified = newId
                ? (CalendarApp.events || []).find(e => e.id === newId)
                : null;
            if (newId && !verified) {
                return {
                    success: false,
                    error: `Google accepted the event (id ${newId}) but it did not show up in the local cache after sync. The event may exist on Google's side — please check the Calendar view directly.`
                };
            }

            return {
                success: true,
                created: {
                    id: newId,
                    summary: eventData.summary,
                    start: startObj,
                    end: endObj,
                    location: eventData.location || undefined,
                    attendees: args.attendees || undefined,
                    account,
                    htmlLink: result.event?.htmlLink || undefined
                }
            };
        },

        async update_calendar_event(args) {
            if (typeof CalendarApp === 'undefined') return { error: 'Calendar app not loaded.' };
            if (!args.id) return { error: 'update_calendar_event requires "id".' };
            CalendarApp.loadData();

            const accountEmails = new Set((CalendarApp.getAccounts() || []).map(a => a.email));
            const event = (CalendarApp.events || []).find(e => e.id === args.id && accountEmails.has(e.account));
            if (!event) return { error: `No calendar event with id "${args.id}" in the active profile.` };

            // Bail if there are no actual fields to change
            const changeKeys = ['summary', 'start', 'end', 'all_day', 'location', 'description'];
            if (!changeKeys.some(k => args[k] !== undefined)) {
                return { error: 'No fields to update. Pass at least one of: summary, start, end, all_day, location, description.' };
            }

            // Carry forward existing values for the IPC payload
            const eventData = {};
            if (args.summary !== undefined) eventData.summary = String(args.summary).trim();
            if (args.location !== undefined) eventData.location = args.location;
            if (args.description !== undefined) eventData.description = args.description;

            // Time fields: if either start, end, or all_day is touched, recompute both sides
            if (args.start !== undefined || args.end !== undefined || args.all_day !== undefined) {
                const tz = (typeof Intl !== 'undefined' && Intl.DateTimeFormat)
                    ? Intl.DateTimeFormat().resolvedOptions().timeZone
                    : null;
                const allDay = args.all_day !== undefined ? !!args.all_day : !!event.allDay;
                const startSrc = args.start || (event.start instanceof Date ? event.start.toISOString() : event.start);
                const endSrc = args.end || (event.end instanceof Date ? event.end.toISOString() : event.end);
                if (allDay) {
                    eventData.start = { date: String(startSrc).slice(0, 10) };
                    eventData.end = { date: String(endSrc).slice(0, 10) };
                } else {
                    const startInfo = AgentTools.parseAgentDateTime(startSrc);
                    if (startInfo.error) return { error: `Invalid "start" value: ${startInfo.error}` };
                    const endInfo = AgentTools.parseAgentDateTime(endSrc);
                    if (endInfo.error) return { error: `Invalid "end" value: ${endInfo.error}` };
                    eventData.start = { dateTime: startInfo.iso };
                    eventData.end = { dateTime: endInfo.iso };
                    if (tz) {
                        eventData.start.timeZone = tz;
                        eventData.end.timeZone = tz;
                    }
                }
            }

            const result = await window.electronCalendar.updateEvent(
                event.account,
                event.calendarId || 'primary',
                event.id,
                eventData
            );
            if (result?.error) {
                return { success: false, error: `Update failed: ${result.error}`, needsReconnect: !!result.needsReconnect };
            }
            if (!result?.success && !result?.event) {
                return { success: false, error: `Update did not return a confirmation event. Raw response: ${JSON.stringify(result)}` };
            }
            await CalendarApp.syncEvents?.();
            AgentTools.refreshApp('calendar');

            return { success: true, updated: { id: event.id, changes: eventData } };
        },

        async delete_calendar_event(args) {
            if (typeof CalendarApp === 'undefined') return { error: 'Calendar app not loaded.' };
            CalendarApp.loadData();

            const search = (args.search || '').trim();
            const id = args.id || null;

            if (!id && !search) {
                return { error: 'delete_calendar_event requires either "search" or "id".' };
            }
            if (!id && search.length < 3) {
                return { error: `Search "${search}" is too short (minimum 3 characters). Use a more specific summary or pass an id.` };
            }

            const accountEmails = new Set((CalendarApp.getAccounts() || []).map(a => a.email));
            let pool = (CalendarApp.events || []).filter(e => accountEmails.has(e.account));

            // Apply search window when fuzzy-matching (default: today → today+30d)
            if (!id) {
                const parseDate = (s, fallback) => {
                    if (!s) return fallback;
                    if (s === 'today') return getDateStr(0);
                    if (s === 'tomorrow') return getDateStr(1);
                    return s;
                };
                const fromStr = parseDate(args.from, getDateStr(0));
                const toStr = parseDate(args.to, getDateStr(30));
                const fromTs = new Date(`${fromStr}T00:00:00`).getTime();
                const toTs = new Date(`${toStr}T23:59:59.999`).getTime();
                pool = pool.filter(e => {
                    const start = e.start instanceof Date ? e.start.getTime() : new Date(e.start).getTime();
                    return start >= fromTs && start <= toTs;
                });
            }

            let target = null;
            if (id) {
                target = pool.find(e => e.id === id);
                if (!target) return { error: `No calendar event with id "${id}" in the active profile.` };
            } else {
                const q = search.toLowerCase();
                const exact = pool.filter(e => (e.summary || '').toLowerCase() === q);
                if (exact.length === 1) {
                    target = exact[0];
                } else if (exact.length > 1) {
                    return {
                        error: `Search "${search}" matches ${exact.length} events with that exact summary. Pass an id to disambiguate.`,
                        candidates: exact.slice(0, 10).map(e => ({
                            id: e.id, summary: e.summary,
                            start: e.start instanceof Date ? e.start.toISOString() : e.start,
                            account: e.account
                        }))
                    };
                } else {
                    const partial = pool.filter(e => (e.summary || '').toLowerCase().includes(q));
                    if (partial.length === 0) return { error: `No calendar event found matching "${search}" in the search window.` };
                    if (partial.length > 1) {
                        return {
                            error: `Search "${search}" is ambiguous — it matches ${partial.length} events. Retry with a more specific search or pass an id.`,
                            candidates: partial.slice(0, 10).map(e => ({
                                id: e.id, summary: e.summary,
                                start: e.start instanceof Date ? e.start.toISOString() : e.start,
                                account: e.account
                            }))
                        };
                    }
                    target = partial[0];
                }
            }

            const mode = args.mode === 'all' ? 'all' : 'single';
            const calendarId = target.calendarId || 'primary';
            const masterId = target.recurringEventId || target.id;
            const targetId = mode === 'all' ? masterId : target.id;

            const deleted = {
                id: target.id,
                summary: target.summary,
                start: target.start instanceof Date ? target.start.toISOString() : target.start,
                account: target.account,
                isRecurring: !!target.recurringEventId,
                mode
            };

            const result = await window.electronCalendar.deleteEvent(target.account, calendarId, targetId);
            if (result?.error) {
                return { success: false, error: `Delete failed: ${result.error}`, needsReconnect: !!result.needsReconnect };
            }

            await CalendarApp.syncEvents?.();
            AgentTools.refreshApp('calendar');

            return { success: true, deleted };
        },

        update_note(args) {
            const data = StorageManager.get('notes') || {};
            const notes = data.notes || [];
            const note = AgentTools.findBySearchOrId(notes, args.search, args.id);
            if (!note) return { error: `Note not found matching "${args.search || args.id}"` };

            if (args.new_title !== undefined) note.title = args.new_title;
            if (args.content !== undefined) {
                note.content = AgentTools.mdToNoteHtml(args.content);
            }
            if (args.append) {
                note.content = (note.content || '') + AgentTools.mdToNoteHtml(args.append);
            }
            if (args.tags !== undefined) note.tags = args.tags;
            note.modifiedAt = new Date().toISOString();

            StorageManager.set('notes', { notes });
            AgentTools.refreshApp('notes');

            return { success: true, note: { id: note.id, title: note.title } };
        },

        /**
         * Existed in the untrusted blocklist since day one but was never
         * implemented (found 2026-08-08: the assistant created a note by
         * mistake and could not clean it up). Guardrails mirror
         * delete_schedule_item; the /^delete_/ permission ask covers
         * consent; removal goes through NotePrompts.remove because notes
         * are record-merged and an untombstoned delete resurrects on sync.
         */
        delete_note(args) {
            const search = (args.search || '').trim();
            const id = (args.id || '').trim() || null;
            if (!id && !search) return { error: 'delete_note requires either "search" or "id".' };
            if (!id && search.length < 3) {
                return { error: `Search "${search}" is too short (minimum 3 characters). Use a more specific title or pass an id.` };
            }
            const data = StorageManager.get('notes') || {};
            const notes = data.notes || [];
            let target = null;
            if (id) {
                target = notes.find(n => n && n.id === id);
                if (!target) return { error: `No note with id "${id}".` };
            } else {
                const q = search.toLowerCase();
                const exact = notes.filter(n => (n.title || '').toLowerCase() === q);
                if (exact.length === 1) target = exact[0];
                else if (exact.length > 1) {
                    return { error: `"${search}" matches ${exact.length} notes with the same title — pass an id.`,
                             candidates: exact.map(n => ({ id: n.id, title: n.title, modifiedAt: n.modifiedAt })) };
                } else {
                    const loose = notes.filter(n => (n.title || '').toLowerCase().includes(q));
                    if (loose.length === 1) target = loose[0];
                    else if (loose.length > 1) {
                        return { error: `"${search}" matches ${loose.length} notes — pass an id.`,
                                 candidates: loose.slice(0, 8).map(n => ({ id: n.id, title: n.title, modifiedAt: n.modifiedAt })) };
                    } else {
                        return { error: `Note not found matching "${search}".` };
                    }
                }
            }
            // An armed routine is a note, but deleting one stops unattended
            // runs — that is delete_routine's consent, not this one's.
            if (typeof NotePrompts !== 'undefined' && NotePrompts.isPrompt(target)
                && NotePrompts.config(target).offline) {
                return { error: `"${target.title}" is an armed routine — use delete_routine (id ${target.id}) so the user consents to stopping its runs.` };
            }
            NotePrompts.remove(target.id);
            AgentTools.refreshApp('notes');
            return { success: true, deleted: { id: target.id, title: target.title || 'Untitled note' } };
        },

        link_items(args) {
            if (args.type === 'task_to_goal') {
                const items = (StorageManager.get('schedule') || {}).scheduleItems || [];
                const goals = (StorageManager.get('goals') || {}).goals || [];
                const task = AgentTools.findBySearchOrId(items, args.itemSearch);
                if (!task) return { error: `Task not found matching "${args.itemSearch}"` };
                const goal = AgentTools.findBySearchOrId(goals, args.targetSearch);
                if (!goal) return { error: `Project not found matching "${args.targetSearch}"` };

                LinkManager.addLink('goals', goal.id, 'schedule', task.id);
                return { success: true, linked: { task: task.title, goal: goal.title } };
            }
            return { error: `Unknown link type: ${args.type}` };
        },


        daily_briefing() {
            const today = getDateStr(0);
            const now = new Date();
            const timeLabel = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

            ScheduleApp.loadData();
            const profiledSchedule = ScheduleApp.scheduleItems;
            const todayItems = profiledSchedule
                .filter(i => ScheduleApp.isItemForToday(i)
                    && !ScheduleApp.isCompletedToday(i)
                    && !ScheduleApp.isAbandonedToday(i)
                    && !isOneTimeAbandoned(i))
                .sort((a, b) => (a.startTime || '').localeCompare(b.startTime || ''));
            // Abandoned occurrences count as resolved — done, just with the
            // honest label — so they land in the completed tally, not remaining.
            const completedToday = profiledSchedule
                .filter(i => ScheduleApp.isCompletedToday(i) || ScheduleApp.isAbandonedToday(i));

            const grouped = ScheduleApp.getGroupedItems();
            const overdue = grouped.overdue || [];

            const goalsData = StorageManager.get('goals') || {};
            const activeGoals = (goalsData.goals || []).filter(g => g.status !== 'completed');

            const journalData = StorageManager.get('journal') || {};
            const recentJournal = (journalData.entries || []).filter(e => e.date === today);

            return {
                today, currentTime: timeLabel,
                schedule: todayItems.map(i => ({
                    title: i.title, start: formatTime12h(i.startTime),
                    goal: LinkManager.getGoalForTask(i.id)?.title || undefined
                })),
                completedCount: completedToday.length,
                overdue: overdue.slice(0, 10).map(i => ({ title: i.title, scheduledDate: i.scheduledDate })),
                activeGoals: activeGoals.map(g => ({
                    title: g.title, status: g.status,
                    group: (typeof g.group === 'string' && g.group.trim()) || undefined
                })),
                todayJournal: recentJournal.map(e => ({
                    mood: e.mood,
                    preview: (e.content || '').replace(/<[^>]*>/g, '').substring(0, 150)
                })),
                stats: {
                    activeGoals: activeGoals.length,
                    tasksRemaining: todayItems.length,
                    completedToday: completedToday.length,
                    overdueCount: overdue.length
                }
            };
        },

        // ── MEMORY ──

        save_memory(args) {
            const type = args.type;
            const body = (args.body || '').trim();
            const title = (args.title || '').trim();
            if (!body) return { error: 'body is required' };
            if (!MemoryManager.TYPES.includes(type)) {
                return { error: `invalid type: ${type}. Allowed: ${MemoryManager.TYPES.join(', ')}` };
            }

            try {
                // saveSmart: exact duplicate → reconfirmed; same title+type
                // with a new body → the fact changed, old value superseded
                // (append-and-supersede, never edit/delete in place).
                const res = MemoryManager.saveSmart({
                    type, title, body,
                    source: 'extracted',
                    convId: (typeof AgentService !== 'undefined' && AgentService.activeConversationId) || undefined,
                    entity: (args.entity || '').trim() || undefined
                });
                if (res.deduped) {
                    return { success: true, deduped: true, id: res.memory.id, title: res.memory.title };
                }
                const out = { success: true, id: res.memory.id, title: res.memory.title, type: res.memory.type };
                if (res.superseded) out.supersededOldValue = res.superseded.body.slice(0, 120);
                return out;
            } catch (e) {
                return { error: e.message };
            }
        },

        list_memories(args) {
            const filter = {};
            if (args.type) filter.type = args.type;
            const memories = MemoryManager.list(filter);
            return {
                count: memories.length,
                memories: memories.map(m => ({
                    id: m.id,
                    type: m.type,
                    title: m.title,
                    body: m.body,
                    updatedAt: m.updatedAt
                }))
            };
        },

        search_memories(args) {
            const query = (args.query || '').trim();
            if (!query) return { error: 'query is required' };
            const hits = MemoryManager.search(query);
            const pages = MemoryManager.searchPages(query);
            // A search hit the model reads counts as usage — feeds the
            // consolidation survivor pick and (one day) ranking.
            if (hits.length) MemoryManager.recordUsage(hits.map(m => m.id));
            return {
                count: hits.length + pages.length,
                memories: hits.map(m => ({ id: m.id, type: m.type, title: m.title, body: m.body, ...(m.entity ? { entity: m.entity } : {}) })),
                pages: pages.map(s => ({
                    title: s.title,
                    summary: (s.summary || '').trim() || MemoryManager._deriveSummary(s.body),
                    snippet: (s.body || '').slice(0, 200)
                }))
            };
        },

        recall_memory(args) {
            const ref = (args.page || '').trim();
            if (!ref) return { error: 'page is required' };
            const page = MemoryManager.findPage(ref);
            if (!page) {
                const titles = MemoryManager.listSections()
                    .filter(s => (s.body || '').trim())
                    .map(s => s.title);
                return { error: `no memory page matching "${ref}"`, pages: titles };
            }
            MemoryManager.recordPageUsage(page.id);
            const CAP = 4000;
            const body = (page.body || '').length > CAP
                ? page.body.slice(0, CAP) + '\n…(truncated)'
                : page.body;
            return { title: page.title, summary: page.summary || '', body, updatedAt: page.updatedAt };
        },

        list_memory_pages() {
            const pages = MemoryManager.listSections().filter(s => (s.body || '').trim());
            return {
                count: pages.length,
                pages: pages.map(s => ({
                    title: s.title,
                    summary: (s.summary || '').trim() || MemoryManager._deriveSummary(s.body),
                    updatedAt: s.updatedAt
                }))
            };
        },

        // In-place page correction for explicit user corrections. Exact
        // find→replace rather than a whole-body rewrite: the model has the
        // verbatim text in context from recall_memory (a copy task, which
        // small models do reliably), and a surgical edit can't silently drop
        // the rest of the page the way a full regeneration can. The edit is
        // marked byUser so compaction treats the corrected wording as
        // authored and won't rewrite the old fact back in.
        update_memory(args) {
            const ref = (args.page || '').trim();
            const find = args.find || '';
            if (!ref) return { error: 'page is required' };
            if (!find.trim()) return { error: 'find is required — copy the exact wrong text from recall_memory' };
            const page = MemoryManager.findPage(ref);
            if (!page) {
                const titles = MemoryManager.listSections()
                    .filter(s => (s.body || '').trim())
                    .map(s => s.title);
                return { error: `no memory page matching "${ref}"`, pages: titles };
            }
            const body = page.body || '';
            if (!body.includes(find)) {
                const CAP = 4000;
                return {
                    error: 'find text not on the page — copy it exactly as it appears in the body below and retry',
                    title: page.title,
                    body: body.length > CAP ? body.slice(0, CAP) + '\n…(truncated)' : body
                };
            }
            const newBody = body.split(find).join(args.replace || '').trim();
            if (!newBody) {
                return { error: 'that would empty the page — if the whole page is wrong, tell the user to delete it from the memory panel' };
            }
            const patch = { body: newBody };
            const summary = (args.summary || '').trim();
            if (summary) patch.summary = summary;
            MemoryManager.updateSection(page.id, patch, { byUser: true });
            // The correction changes what the next turn's briefing should say,
            // and an open memory panel should show it immediately.
            try { if (typeof AgentService !== 'undefined') AgentService._briefingCache?.clear(); } catch { /* ignore */ }
            try { if (typeof AgentUI !== 'undefined') AgentUI.refreshProfilePanelIfOpen(); } catch { /* ignore */ }
            return { success: true, title: page.title, corrected: true };
        },

        delete_memory(args) {
            const id = (args.id || '').trim();
            if (!id) return { error: 'id is required' };
            const mem = MemoryManager.get(id);
            if (!mem) return { error: 'memory not found' };
            MemoryManager.delete(id);
            return { success: true, deleted: { id: mem.id, title: mem.title } };
        },

        // ── LIBRARY handlers live in js/apps/reader/library-tools.js ──

        // ── DECISIONS (per-record) ──

        save_decision(args) {
            const title = (args.title || '').trim();
            const body = (args.decision || '').trim();
            if (!title) return { error: 'title is required — it is the handle a later save reuses to supersede this decision' };
            if (!body) return { error: 'decision text is required' };
            // The wire enum stays 'goal' (the pre-rename key) while every
            // description says "project" — accept the word the prose teaches.
            const type = args.type === 'project' ? 'goal' : args.type;
            const resolved = DecisionStore.resolveKey(type, { id: args.id, name: args.name });
            if (resolved.error) return { error: resolved.error };
            try {
                const res = DecisionStore.saveSmart({
                    key: resolved.key, title, body,
                    convId: (typeof AgentService !== 'undefined' && AgentService.activeConversationId) || undefined,
                    source: 'chat'
                });
                const out = {
                    success: true,
                    id: res.decision.id,
                    key: resolved.key,
                    title: res.decision.title,
                    recordTitle: resolved.recordTitle
                };
                if (res.deduped) out.deduped = true;
                if (res.superseded) out.superseded = res.superseded.title;
                return out;
            } catch (e) {
                return { error: e.message };
            }
        },

        list_decisions(args) {
            const type = args.type === 'project' ? 'goal' : args.type;   // the save_decision alias
            const resolved = DecisionStore.resolveKey(type, { id: args.id, name: args.name });
            if (resolved.error) return { error: resolved.error };
            const list = DecisionStore.listFor(resolved.key, { includeSuperseded: !!args.include_superseded });
            return {
                key: resolved.key,
                recordTitle: resolved.recordTitle,
                count: list.length,
                decisions: list.map(d => ({
                    id: d.id,
                    title: d.title,
                    body: d.body,
                    savedAt: d.createdAt,
                    ...(d.source === 'user' ? { addedByUser: true } : {}),
                    ...(d.supersededAt ? { supersededAt: d.supersededAt } : {})
                }))
            };
        },

        delete_decision(args) {
            const id = (args.id || '').trim();
            if (!id) return { error: 'id is required' };
            const d = DecisionStore.get(id);
            if (!d) return { error: 'decision not found' };
            DecisionStore.remove(id);
            return { success: true, deleted: { id: d.id, title: d.title, key: d.key } };
        },

        // ── ROUTINES (Prompt Feed) ──

        // The guided intake, mirroring start_goal_interview: a fixed agenda
        // the model asks one topic at a time, ending in ONE create_routine
        // call — which stays the arming consent. No draft store on purpose
        // (see RoutineInterview's header): an interrupted interview leaves
        // nothing armed, which is the correct failure.
        start_routine_interview() {
            if (typeof RoutineInterview === 'undefined' || typeof NotePrompts === 'undefined') {
                return { error: 'Routines are unavailable' };
            }
            const existing = NotePrompts.list().slice(0, 30).map(n => {
                const cfg = NotePrompts.config(n);
                return {
                    title: n.title || 'Untitled routine',
                    trigger: NotePrompts.triggerLabel(cfg),
                    runMode: cfg.runMode === 'task' ? 'task' : 'digest'
                };
            });
            return {
                instructions:
                    'Run this as an interview, not a form. Open with ONE short line on what a routine is ' +
                    '(Anjadhe doing something for them on its own — on a schedule, when an email arrives, or ' +
                    'when a file lands) and offer the purpose examples so they have something to react to. ' +
                    'Then ask ONE topic at a time, in the order given, waiting for each answer: use `why` for ' +
                    'why it matters, `hint` for how to handle the answer. Derive what you can from what they ' +
                    'already said instead of re-asking it; skip a topic their words already answered. Do not ' +
                    'add topics of your own. Nothing is saved as you go — the interview ends with the review ' +
                    'topic: read the routine back (trigger, answer-vs-actions, prompt), then call ' +
                    'create_routine ONCE; the app then shows the arming confirmation, and that approval is ' +
                    'what turns it on. If they already have a similar routine (see existingRoutines), say so ' +
                    'and offer update_routine instead of a duplicate.',
                agenda: RoutineInterview.INTERVIEW.map(t => ({
                    id: t.id, question: t.question, why: t.why,
                    examples: t.examples, hint: t.hint
                })),
                nextTopic: RoutineInterview.topic('purpose'),
                context: {
                    today: (typeof ScheduleApp !== 'undefined' && ScheduleApp.getLocalToday)
                        ? ScheduleApp.getLocalToday() : UIUtils.todayISO(),
                    existingRoutines: existing
                }
            };
        },

        // C10: the ONE way the assistant arms recurring work — the old
        // create_scheduled_prompt (digests) and create_automation (triggered
        // tasks) are this. It is in PermissionManager.ASK_TOOLS: the consent
        // dialog showing the prompt and the trigger IS the permission to run
        // unattended, and it is asked for every routine, because after the
        // merge the category no longer predicts whether a run can write.
        //
        // There was a SECOND create_routine handler further down this object
        // until 2026-08-03 — a `goal`-shaped leftover from create_automation,
        // adapted during the C10 merge while this one was renamed from
        // create_scheduled_prompt. A duplicate key in an object literal wins
        // silently, so the model called the tool exactly as the schema
        // describes it ({prompt, trigger}) and got back "goal required" every
        // time, and the record pill read `result.id` off a result that only
        // carried `routineId`. Keep ONE handler per tool: the schema above,
        // the consent dialog in agent-ui (which reads args.prompt/title/
        // trigger) and write-ledger's RECORD_TOOLS entry all speak this
        // contract.
        /**
         * `voice` on create/update_routine: a Writing Voice NAME from the
         * user's words, resolved to its stable id here (renames must not
         * orphan a routine's styling). A wrong name errors listing what
         * exists — silently posting in the assistant's own voice would wear
         * the button's promise without keeping it.
         */
        _resolveVoiceArg(voice) {
            const wanted = String(voice || '').trim();
            if (!wanted) return { voiceId: null };
            if (typeof VoiceStore === 'undefined') {
                return { error: 'Writing Voices are unavailable in this build — create the routine without a voice.' };
            }
            const v = VoiceStore.resolve(wanted);
            if (!v) {
                const names = VoiceStore.pages().map(p => p.name).join(', ');
                return { error: `No Writing Voice named "${wanted}".${names ? ` Voices: ${names}.` : ' None exist yet — the user can create one in the Writing Voices app.'}` };
            }
            if (!(v.body || '').trim()) {
                return { error: `The Writing Voice "${v.name}" has not been studied yet — the user can open it in the Writing Voices app and press Study first.` };
            }
            return { voiceId: v.id, voiceName: v.name };
        },

        create_routine(args) {
            if (typeof NotePrompts === 'undefined') return { error: 'Routines are unavailable' };
            const body = (args.prompt || '').trim();
            if (!body) return { error: 'prompt is required' };
            // A routine with no title shows up on the feed and the Routines
            // page as "Untitled" — fall back to the prompt's first line, the
            // way the deleted handler did.
            const firstLine = body.split('\n')[0].trim();
            const title = (args.title || '').trim()
                || (firstLine.length > 70 ? firstLine.slice(0, 67).trimEnd() + '…' : firstLine);

            const t = (args.trigger && typeof args.trigger === 'object') ? args.trigger : {};
            const runMode = args.runMode === 'task' ? 'task' : 'digest';
            if (runMode === 'task' && (typeof TaskService === 'undefined'
                || typeof FEATURES === 'undefined' || !FEATURES.isEnabled('taskmode'))) {
                return { error: 'Task-mode routines need task mode, which is off in this build. A digest routine still works.' };
            }
            // Validated here rather than left to config()'s fallback: a user
            // who asked for "when an invoice arrives" must not silently get
            // "every day".
            if (!['time', 'email', 'file'].includes(t.type)) {
                return { error: 'trigger.type must be time, email, or file' };
            }
            if (t.type === 'email' && !String(t.from || '').trim()
                && !String(t.subject || '').trim() && !String(t.contains || '').trim()) {
                return { error: 'an email trigger needs a from, subject and/or contains to match' };
            }
            if (t.type === 'file' && !String(t.folder || '').trim()) {
                return { error: 'a file trigger needs a folder path' };
            }
            const voiceRes = this._resolveVoiceArg(args.voice);
            if (voiceRes.error) return { error: voiceRes.error };
            if (voiceRes.voiceId && runMode === 'task') {
                return { error: 'A voice styles written posts; a task-mode run keeps a log, not prose. Use runMode "digest" with a voice.' };
            }

            // Dedup by title against existing routines, mirroring
            // create_schedule_item's guard against re-creates.
            if (title) {
                const existing = NotePrompts.list().filter(n => NotePrompts.config(n).offline);
                const dup = existing.find(n => (n.title || '').trim().toLowerCase() === title.toLowerCase());
                if (dup) {
                    return { success: true, alreadyExisted: true, id: dup.id, title: dup.title,
                             trigger: NotePrompts.triggerLabel(NotePrompts.config(dup)) };
                }
            }
            const note = NotePrompts.create({ title, body, config: {
                offline: true,
                runMode,
                trigger: t,
                // The flat fields stay the source of truth for a time
                // trigger — config()._trigger reads them back.
                interval: t.type === 'time' ? (t.interval || 'daily') : 'daily',
                time: t.type === 'time' ? (t.time || null) : null,
                web: runMode === 'digest' && !!args.web,
                useContext: runMode === 'digest' && !!args.useContext,
                voiceId: voiceRes.voiceId,
                // Pin execution to the Mac that armed it; the record itself
                // syncs to all of them (C10).
                homeMachineId: (typeof RoutineEngine !== 'undefined' && RoutineEngine._machineId) || null
            }});
            if (typeof RoutineEngine !== 'undefined') RoutineEngine.onRoutinesChanged();
            const cfg = NotePrompts.config(note);
            return {
                success: true, id: note.id, title: note.title,
                trigger: NotePrompts.triggerLabel(cfg), runMode,
                web: cfg.web, useContext: cfg.useContext,
                ...(voiceRes.voiceName ? { voice: voiceRes.voiceName } : {}),
                // "First run starts in a couple of minutes" is only true of a
                // SCHEDULE. An email/file routine waits for its trigger, and
                // telling the user to expect a post shortly would read as a
                // failure when nothing arrived.
                note: runMode === 'task'
                    ? 'Armed on this Mac. A step needing permission pauses and notifies rather than opening a dialog nobody is there to click. Each run keeps its log on the routine (Routines page, Run history) — action runs do not post to the Home feed.'
                    : (t.type === 'time'
                        ? 'First run starts within a couple of minutes; results appear in the Feed on the Home page.'
                        : 'Armed on this Mac. It runs when the trigger fires, and each run posts its answer to the Feed on the Home page.')
            };
        },

        list_routines(args, ctx) {
            if (typeof NotePrompts === 'undefined') return { error: 'Routines are unavailable' };
            let prompts = NotePrompts.list().filter(n => NotePrompts.config(n).offline);
            const runs = (typeof RoutineEngine !== 'undefined' && RoutineEngine.state.runs) || {};
            const errors = (typeof RoutineEngine !== 'undefined' && RoutineEngine.state.errors) || {};
            // Snippet, not the full body: a dozen prompts with full text blows
            // the 6k result cap and the hard-trim cuts the list mid-record, so
            // the model silently sees only the first ~8 prompts.
            const PROMPT_SNIPPET = 200;
            const result = {
                count: prompts.length,
                prompts: prompts.map(n => {
                    const cfg = NotePrompts.config(n);
                    const body = NotePrompts.bodyText(n);
                    return {
                        id: n.id, title: n.title || 'Untitled prompt',
                        prompt: body.length > PROMPT_SNIPPET
                            ? body.slice(0, PROMPT_SNIPPET) + `… (truncated — get_note id=${n.id} for the full prompt)`
                            : body,
                        interval: cfg.interval, time: cfg.time,
                        trigger: NotePrompts.triggerLabel(cfg),
                        runMode: cfg.runMode,
                        web: cfg.web, useContext: cfg.useContext,
                        ...(cfg.voiceId && typeof VoiceStore !== 'undefined' && VoiceStore.byId(cfg.voiceId)
                            ? { voice: VoiceStore.byId(cfg.voiceId).name } : {}),
                        lastRun: runs[n.id] || null,
                        lastError: errors[n.id] || null
                    };
                })
            };
            return AgentTools._withDecisions(result,
                result.prompts.map(p => ({ key: `routine:${p.id}`, into: p })), ctx);
        },

        update_routine(args) {
            if (typeof NotePrompts === 'undefined') return { error: 'Routines are unavailable' };
            const id = (args.id || '').trim();
            if (!id) return { error: 'id is required' };
            if (!NotePrompts.list().some(n => n.id === id)) {
                return { error: 'Routine not found — call list_routines for ids' };
            }
            const config = { offline: true };
            if (args.interval !== undefined) config.interval = args.interval;
            if (args.time !== undefined) config.time = args.time || null;
            if (args.web !== undefined) config.web = !!args.web;
            if (args.useContext !== undefined) config.useContext = !!args.useContext;
            if (args.voice !== undefined) {
                const voiceRes = this._resolveVoiceArg(args.voice);
                if (voiceRes.error) return { error: voiceRes.error };
                config.voiceId = voiceRes.voiceId;   // null clears ("" = assistant's own)
            }
            const note = NotePrompts.update(id, {
                title: typeof args.title === 'string' ? args.title : undefined,
                body: typeof args.prompt === 'string' ? args.prompt : undefined,
                config
            });
            if (!note) return { error: 'Routine not found' };
            if (typeof RoutineEngine !== 'undefined') RoutineEngine.onRoutinesChanged();
            const cfg = NotePrompts.config(note);
            return { success: true, id: note.id, title: note.title,
                     schedule: NotePrompts.scheduleLabel(cfg), web: cfg.web, useContext: cfg.useContext,
                     ...(cfg.voiceId && typeof VoiceStore !== 'undefined' && VoiceStore.byId(cfg.voiceId)
                         ? { voice: VoiceStore.byId(cfg.voiceId).name } : {}) };
        },

        delete_routine(args) {
            if (typeof NotePrompts === 'undefined') return { error: 'Routines are unavailable' };
            const id = (args.id || '').trim();
            if (!id) return { error: 'id is required' };
            const note = NotePrompts.list().find(n => n.id === id);
            if (!note) return { error: 'Routine not found — call list_routines for ids' };
            NotePrompts.remove(id);
            return { success: true, deleted: { id: note.id, title: note.title || 'Untitled prompt' } };
        },

        // ── BUILD (user-built apps, read-only) ──

        async list_creations() {
            const out = { apps: [] };
            try {
                const entries = await window.electronApps?.list?.();
                out.apps = (Array.isArray(entries) ? entries : []).map(e => ({
                    appId: e.dir,
                    name: e.manifest?.name || e.dir,
                    kind: e.spec ? 'spec' : 'code',
                    description: e.manifest?.description || undefined,
                    broken: e.error ? true : undefined
                }));
            } catch { /* apps dir missing / feature off — empty list is the answer */ }
            return out;
        },

        async read_creation(args) {
            const PAGE = 18000;
            const off = Math.max(0, Number(args.offset) || 0);
            const page = (text) => {
                const s = String(text ?? '');
                if (s.length <= PAGE && !off) return s;
                const slice = s.slice(off, off + PAGE);
                return {
                    totalChars: s.length,
                    offset: off,
                    shownChars: slice.length,
                    note: off + slice.length < s.length
                        ? `Truncated — call read_creation again with offset ${off + slice.length} (and the same file) to continue.`
                        : 'End of file.',
                    content: slice
                };
            };

            if (args.appId) {
                const entries = (await window.electronApps?.list?.()) || [];
                const entry = entries.find(e => e.dir === args.appId);
                if (!entry) return { error: `No app with id "${args.appId}". Call list_creations for valid ids.` };
                const all = { 'manifest.json': entry.manifestRaw, 'app.spec.json': entry.spec, 'app.js': entry.js, 'app.css': entry.css };
                const files = {};
                for (const [name, content] of Object.entries(all)) {
                    if (content == null || content === '') continue;
                    if (args.file && args.file !== name) continue;
                    files[name] = page(content);
                }
                if (!Object.keys(files).length) {
                    return { error: args.file ? `App "${args.appId}" has no ${args.file}.` : `App "${args.appId}" has no readable files.` };
                }
                return { kind: entry.spec ? 'spec-app' : 'code-app', appId: entry.dir, files };
            }

            return { error: 'Pass appId — call list_creations to find it.' };
        },

        // ── FILES + SHELL (C3) ──
        // Thin wrappers: scope enforcement, caps, and the permission grants
        // all live in the main process (agent-fs-* / agent-run-command IPC).

        fs_list(args) {
            if (!window.electronAgentFS?.list) return { error: 'File tools not available in this build.' };
            return window.electronAgentFS.list(args.path, args.pattern);
        },

        fs_read(args) {
            if (!window.electronAgentFS?.read) return { error: 'File tools not available in this build.' };
            return window.electronAgentFS.read(args.path, args.offset);
        },

        fs_search(args) {
            if (!window.electronAgentFS?.search) return { error: 'File tools not available in this build.' };
            return window.electronAgentFS.search(args.path, args.query);
        },

        fs_write(args) {
            if (!window.electronAgentFS?.write) return { error: 'File tools not available in this build.' };
            return window.electronAgentFS.write(args.path, args.content);
        },

        fs_mkdir(args) {
            if (!window.electronAgentFS?.mkdir) return { error: 'File tools not available in this build.' };
            return window.electronAgentFS.mkdir(args.path);
        },

        fs_trash(args) {
            if (!window.electronAgentFS?.trash) return { error: 'File tools not available in this build.' };
            return window.electronAgentFS.trash(args.path);
        },

        fs_move(args) {
            if (!window.electronAgentFS?.move) return { error: 'File tools not available in this build.' };
            return window.electronAgentFS.move(args.from, args.to);
        },

        async run_command(args) {
            if (!window.electronAgentFS?.run) return { error: 'Shell tool not available in this build.' };
            const res = await window.electronAgentFS.run(args.command, args.cwd, args.timeoutSec);
            return AgentTools._annotateDiskFree(res);
        },

        run_applescript(args) {
            if (!window.electronAgentFS?.runAppleScript) return { error: 'AppleScript tool not available in this build.' };
            return window.electronAgentFS.runAppleScript(args.script);
        },

        list_shortcuts() {
            if (!window.electronAgentFS?.listShortcuts) return { error: 'Shortcuts tool not available in this build.' };
            return window.electronAgentFS.listShortcuts();
        },

        run_shortcut(args) {
            if (!window.electronAgentFS?.runShortcut) return { error: 'Shortcuts tool not available in this build.' };
            return window.electronAgentFS.runShortcut(args.name);
        },

        process_start(args) {
            if (!window.electronAgentFS?.processStart) return { error: 'Background processes not available in this build.' };
            return window.electronAgentFS.processStart(args.command, args.cwd);
        },

        process_status(args) {
            if (!window.electronAgentFS?.processStatus) return { error: 'Background processes not available in this build.' };
            return window.electronAgentFS.processStatus(args.processId);
        },

        process_stop(args) {
            if (!window.electronAgentFS?.processStop) return { error: 'Background processes not available in this build.' };
            return window.electronAgentFS.processStop(args.processId);
        },

        process_list() {
            if (!window.electronAgentFS?.processList) return { error: 'Background processes not available in this build.' };
            return window.electronAgentFS.processList();
        },

        async start_task(args) {
            if (typeof TaskService === 'undefined') return { error: 'Task mode not available in this build.' };
            const convId = (typeof AgentService !== 'undefined') ? AgentService.activeConversationId : null;
            const res = await TaskService.start(args.goal, convId);
            if (res.error) return { error: res.error };
            return {
                ok: true,
                taskId: res.taskId,
                plan: res.steps,
                note: 'Plan created and shown to the user for approval. END YOUR REPLY NOW with one short sentence — the task runs by itself after they approve; do not do the steps yourself.'
            };
        },

        async run_recipe(args) {
            if (typeof RecipeService === 'undefined') return { error: 'Recipes not available in this build.' };
            return await RecipeService.run(args?.name, args?.params);
        },
    },
};

// fs/shell tools ship behind the `agentfs` feature flag (docs/COWORK_AGENT.md
// phasing: every phase gets an isolated-instance pass before default-on).
// When off, the definitions and handlers are stripped so the model never
// sees the tools. Enable locally with:
//     localStorage.setItem('anjadheFeatures', 'agentfs')
if (typeof FEATURES === 'undefined' || !FEATURES.isEnabled('agentfs')) {
    const CUT = new Set(['fs_list', 'fs_read', 'fs_search', 'fs_write', 'fs_mkdir', 'fs_trash', 'fs_move', 'run_command', 'run_applescript', 'list_shortcuts', 'run_shortcut', 'process_start', 'process_status', 'process_stop', 'process_list']);
    AgentTools.definitions = AgentTools.definitions.filter(d => !CUT.has(d.function && d.function.name));
    for (const name of CUT) {
        delete AgentTools.handlers[name];
        delete AgentTools._toolGroups[name];
    }
}

// The library tools graduated with their flag (2026-08-08) — always on.

// Task mode (C4) ships behind its own flag the same way. Recipes (C8.3) are
// born from tasks, so they follow the same flag.
//
// C10: create_routine is deliberately NOT cut here. A routine is a routine
// whether or not it can act — with task mode off, digest routines are still
// the whole scheduled-prompt feature, and the handler refuses `runMode:'task'`
// on its own with a message saying why.
if (typeof FEATURES === 'undefined' || !FEATURES.isEnabled('taskmode')) {
    AgentTools.definitions = AgentTools.definitions.filter(d => d.function && !['start_task', 'run_recipe'].includes(d.function.name));
    delete AgentTools.handlers.start_task;
    delete AgentTools.handlers.run_recipe;
}

