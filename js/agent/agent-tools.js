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

// Calendar instants FOR THE MODEL: local wall-clock with the offset
// ("2026-09-09T16:30:00-07:00") plus a readable form, never
// toISOString()'s UTC "…Z". The prompt states today's date and time in
// local terms with no zone, so a UTC instant beside it made the model
// do the UTC→PDT arithmetic itself (and narrate it) — fragile at date
// boundaries and DST at the 12B floor. All-day events stay date-only.
// Storage is untouched: CalendarApp.saveData still writes UTC ISO.
function localTimeZone() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch { return null; }
}
function calendarInstant(v, allDay) {
    if (!v) return null;
    if (allDay && typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
    const d = v instanceof Date ? v : new Date(v);
    if (isNaN(d.getTime())) return typeof v === 'string' ? v : null;
    const p = n => String(n).padStart(2, '0');
    if (allDay) return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    const off = -d.getTimezoneOffset();
    const sign = off >= 0 ? '+' : '-';
    const abs = Math.abs(off);
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${sign}${p(Math.floor(abs / 60))}:${p(abs % 60)}`;
}
function calendarInstantLabel(v, allDay) {
    if (!v) return null;
    const d = v instanceof Date ? v : new Date(allDay && /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? `${v}T00:00:00` : v);
    if (isNaN(d.getTime())) return null;
    return d.toLocaleString('en-US', allDay
        ? { weekday: 'short', month: 'short', day: 'numeric' }
        : { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
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
            name: 'list_notes',
            description: 'List notes (title, when it was last changed, and an opening snippet); optional keyword search. Returns at most 20. Snippets are only the first few lines — call get_note to read a note\'s actual content.',
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
            // AI native (2026-10-02, docs/AI_NATIVE.md): the model loads the
            // tool groups it needs; no word list guesses them. The catalog in
            // the description is filled in by definitionsFor (useToolsDef).
            name: 'use_tools',
            description: 'Load more of your tools.',
            parameters: { type: 'object', properties: {
                groups: { type: 'array', items: { type: 'string' }, description: 'Group names from the list above' }
            }, required: ['groups'] }
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
            description: 'Search across projects, notes, tasks, calendar events (kind "event"; a recurring series is one hit), portfolio accounts/properties, and the user\'s Documents (imported files — matched by title, tag AND content; a document hit carries kind "document" and a passage, and read_library_doc reads it in full). Results are ranked, best match first. Note hits may carry kind "routine", "routine result", or "saved prompt" — those are scheduled prompts and their machine-written output posts, NOT the user\'s own records; never treat one as an account, task, or personal note.',
            parameters: { type: 'object', properties: {
                query: { type: 'string' }
            }, required: ['query'] }
        }},
        { type: 'function', function: {
            // Enum stays in sync with HelpDocs.docs (help-docs.js) — the
            // handler validates against the live corpus, so a drifted enum
            // degrades to the index rather than erroring.
            name: 'get_help',
            description: 'The built-in nenva user guide. Call for ANY question about nenva itself — how to use a feature, where a setting lives, what something does — and answer from the returned doc, never from guesses about the UI. Topics: getting-started (first steps), your-day (Actions/Tasks/Plan), the-assistant (chat, memory, modes, routines), ai-models (local/server/API-key models, switching), ai-activity (what the AI engine is doing, GPU use, activity page), web-search (search keys), connected-accounts (Gmail/Calendar/Apple apps/iMessage/Slack/Notion/Linear), telegram (chatting with the assistant from Telegram, step by step), everyday-apps (Notes/Journal/Bookmarks/Portfolio), how-anjadhe-works (privacy, sync, profiles, shortcuts), license (what nenva costs, the free alpha license, claiming or entering a key), settings (map of every Settings section).',
            parameters: { type: 'object', properties: {
                topic: { type: 'string', enum: ['getting-started', 'your-day', 'the-assistant', 'ai-models', 'cloud-privacy', 'ai-activity', 'web-search', 'connected-accounts', 'telegram', 'everyday-apps', 'how-anjadhe-works', 'license', 'settings'], description: 'The closest topic. Omit to get the topic index.' }
            }}
        }},
        { type: 'function', function: {
            name: 'get_setup_status',
            description: 'What is actually set up on THIS Mac right now, i.e. everything Settings shows: Google accounts (Gmail/Calendar), live Slack/Notion/Linear and other tool-server connections, every source (texts, Apple Calendar/Reminders/Notes, files…) and whether the AI may see it, what left this Mac in the last 7 days (when, which service, what kind; never content), this month\'s nenva cloud and search use, the AI model, web search, backup (last backup), Lock, usage statistics, Telegram, paired phones, whether scheduled routines are paused, and the app version. Read-only: changing any of these is the person\'s, in Settings. Call BEFORE answering any "how do I connect / enable …", "is Slack connected?", "am I connected?", "are you reading my texts?", "did anything go to the cloud?", "how much allowance is left?", "when did I last back up?", or missing-access question. Google accounts are not the connector list. A failed status check means unknown, not disconnected. Connection does not imply background monitoring.',
            parameters: { type: 'object', properties: {} }
        }},

        // WRITE
        { type: 'function', function: {
            name: 'create_note',
            description: 'Create a note (a text document the person keeps; it records which chat it came from).',
            parameters: { type: 'object', properties: {
                title: { type: 'string' },
                content: { type: 'string' },
                tags: { type: 'array', items: { type: 'string' },
                    // Live (2026-10-07, NoteTags): the person's own tags ride
                    // the schema, so the model picks from them rather than
                    // inventing near-duplicates. A getter, because every
                    // consumer of `definitions` (definitionsFor, the core
                    // warm-up, specialists) reads the array directly; it is
                    // evaluated when the schema is serialized for a call.
                    get description() {
                        const have = (typeof NoteTags !== 'undefined' && typeof StorageManager !== 'undefined')
                            ? NoteTags.existing({ tags: StorageManager.get('tags'), notes: StorageManager.get('notes') }) : [];
                        const list = have.slice(0, 80).join(', ') + (have.length > 80 ? ', …' : '');
                        return 'Optional. Use the person\'s EXISTING tags that fit' + (list ? ` — they have: ${list}.` : '.')
                            + ' Only if none fits, give exactly ONE new tag that best describes the content; extra new tags are dropped.';
                    } }
            }, required: ['title'] }
        }},
        // ACTION


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
            name: 'search_gmail',
            description: 'Search the WHOLE Gmail mailbox on Google\'s servers with Gmail\'s own search, nothing downloaded: archived mail and mail older than the local sync included. Use when list_emails finds nothing or the mail may be archived or old. query uses Gmail search syntax (from:, to:, subject:, after:YYYY/MM/DD, before:, has:attachment, filename:pdf, in:anywhere, "exact phrase"). Returns headers and Gmail\'s snippet; read one with get_email (id + account).',
            parameters: { type: 'object', properties: {
                query: { type: 'string', description: 'Gmail search query' },
                account: { type: 'string', description: 'Email address; default: every connected account' },
                limit: { type: 'number', description: 'Default 20, max 50 per account' }
            }, required: ['query'] }
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
            description: 'Get full contents of one email by id (from list_emails or search_gmail). Returns up to ~5000 chars of body; pass offset to continue a truncated body. When the current model can view images, the email\'s pictures (inline images and image attachments) are attached to the result for you to read directly — many emails carry their real content in a picture. Also lists any other ATTACHMENTS (PDF, xlsx, docx…) — their contents are not included, use read_email_attachment for those.',
            parameters: { type: 'object', properties: {
                id: { type: 'string' },
                account: { type: 'string', description: 'For a search_gmail result not synced here: its account' },
                offset: { type: 'number', description: 'Character offset into the body to continue reading a long email (from the previous result\'s offset + shown length).' },
                images: { type: 'boolean', description: 'Default true: attach the email\'s images when the model can view them. Pass false to skip them.' }
            }, required: ['id'] }
        }},
        { type: 'function', function: {
            name: 'read_email_attachment',
            description: 'Read a file attached to an email — PDFs (including scanned ones, read by OCR on this Mac), Excel and Word documents, plain text, and images (png/jpeg/webp/gif, shown to you when the model has vision). Use whenever the answer depends on what an attachment says: an invoice amount or due date, a statement total, the terms in a contract. Get the id and attachmentId from get_email first. NEVER guess or infer a figure or date that lives in an attachment you have not read — say you could not read it instead.',
            parameters: { type: 'object', properties: {
                id: { type: 'string', description: 'The email id (from list_emails / search_gmail / get_email)' },
                account: { type: 'string', description: 'For a search_gmail result not synced here: its account' },
                attachmentId: { type: 'string', description: 'From get_email\'s attachments list. Omit only when the email has exactly one attachment.' },
                filename: { type: 'string', description: 'Alternative to attachmentId — the attachment\'s filename' }
            }, required: ['id'] }
        }},
        { type: 'function', function: {
            name: 'list_email_analyses',
            description: 'What each recent email said when it was read (summary, action items, amounts), per MESSAGE. For what the person has to deal with, use list_matters / get_matter: one tracked item per real thing, with its step and every message about it.',
            parameters: { type: 'object', properties: {
                unread_only: { type: 'boolean', description: 'Default: true — skip messages whose tracked item is settled' },
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
            name: 'find_contact',
            description: 'Find a recipient by name or address in local email headers and saved recipients (email), or recent one-to-one text conversations (text). Use before drafting or sending to a name. Returns actual destinations and their sources, not verified identities. If ambiguous, ask which person/address; if no match, ask for the address or number. Never invent one or assume an email and a text contact with the same name are the same person. Use the chosen destination in the draft and send tool.',
            parameters: { type: 'object', properties: {
                query: { type: 'string', description: 'Name, email address or phone number to look up' },
                channel: { type: 'string', enum: ['email', 'text'], description: 'The channel the user requested; ask if unclear' }
            }, required: ['query', 'channel'] }
        }},
        { type: 'function', function: {
            name: 'send_email',
            description: 'Send an email from a connected Gmail account. Look up names with find_contact first and show the chosen email address in the draft. For replies, pass replyToId and the recipient + threading are inferred.',
            parameters: { type: 'object', properties: {
                to: { type: 'string', description: 'Actual email addresses, comma-separated, optionally Name <address>; never a bare name. Required unless replyToId is set' },
                subject: { type: 'string' },
                body: { type: 'string', description: 'Plain text; HTML-escaped, newlines become <br>' },
                cc: { type: 'string' },
                bcc: { type: 'string' },
                account: { type: 'string' },
                replyToId: { type: 'string' }
            }, required: ['body'] }
        }},
        { type: 'function', function: {
            name: 'send_text',
            description: 'Send a text message (iMessage, or SMS when the recipient has no iMessage) through the Messages app on this Mac. Look up names with find_contact (channel text) first and show the chosen number or iMessage email before sending. Recipient: a phone number, an iMessage email, "me" (the user\'s own number), or the name of someone they recently texted. This is NOT email — for email use send_email.',
            parameters: { type: 'object', properties: {
                to: { type: 'string', description: 'Phone number, iMessage email, "me", or a recent contact\'s name' },
                body: { type: 'string', description: 'The text, plain. Short — it is a text message; no subject, no sign-off.' }
            }, required: ['to', 'body'] }
        }},

        // CALENDAR (Google Calendar via connected accounts, plus this Mac's
        // Apple Calendar when its mirror is on — writes go through EventKit)
        { type: 'function', function: {
            name: 'list_calendar_events',
            description: 'List calendar events across connected Google accounts and this Mac\'s Apple Calendar (locally synced). Each event says which account/source it belongs to.',
            parameters: { type: 'object', properties: {
                from: { type: 'string', description: 'YYYY-MM-DD or "today"/"tomorrow". Default: today.' },
                to: { type: 'string', description: 'Inclusive end. Default: same as from.' },
                query: { type: 'string', description: 'Substring filter against summary/location/description' },
                limit: { type: 'number', description: 'Default 50' }
            }}
        }},
        { type: 'function', function: {
            name: 'create_calendar_event',
            description: 'Create a calendar event in a Google account or an Apple calendar on this Mac. Use naive local "YYYY-MM-DDTHH:MM:SS" (no Z/offset); tool attaches user timezone. For all-day: all_day=true, pass YYYY-MM-DD.',
            parameters: { type: 'object', properties: {
                summary: { type: 'string' },
                start: { type: 'string', description: '"YYYY-MM-DDTHH:MM:SS", or "YYYY-MM-DD" if all_day' },
                end: { type: 'string', description: 'Same format as start. Default: start + 1h.' },
                all_day: { type: 'boolean' },
                location: { type: 'string' },
                description: { type: 'string' },
                attendees: { type: 'array', items: { type: 'string' }, description: 'Google accounts only' },
                repeat: { type: 'string', enum: ['none', 'daily', 'weekdays', 'weekly', 'monthly', 'annually'], description: 'Make it a series (the Calendar\'s Repeat presets). Weekly repeats on the start weekday, monthly on the start day of month.' },
                account: { type: 'string', description: 'A Google account email, "apple" (the one writable Apple calendar, or ask), or an Apple calendar name such as "Home" / "apple:Home". Required when more than one destination exists.' }
            }, required: ['summary', 'start'] }
        }},
        { type: 'function', function: {
            name: 'update_calendar_event',
            description: 'Update a calendar event (Google or Apple). Only passed fields change. For one occurrence of a series pass scope "this" (default) or "all".',
            parameters: { type: 'object', properties: {
                id: { type: 'string' },
                summary: { type: 'string' },
                start: { type: 'string', description: 'Naive local "YYYY-MM-DDTHH:MM:SS"' },
                end: { type: 'string' },
                all_day: { type: 'boolean' },
                location: { type: 'string' },
                description: { type: 'string' },
                scope: { type: 'string', enum: ['this', 'all'], description: 'For an occurrence of a series. "this" (default) changes only this occurrence. "all" changes every occurrence: title, details, location, calendar, repeat and the clock TIME travel to the series; the DATE never does (moving a date is a "this" edit).' },
                repeat: { type: 'string', enum: ['none', 'daily', 'weekdays', 'weekly', 'monthly', 'annually'], description: 'Change how it repeats ("none" ends the series). For a standalone event, or a series with scope "all" whose rule is one of these presets.' },
                calendar: { type: 'string', description: 'Apple events only: move the event to another Apple calendar, by name (e.g. "Home").' }
            }, required: ['id'] }
        }},
        { type: 'function', function: {
            name: 'delete_calendar_event',
            description: 'Delete a calendar event (Google or Apple). search ≥3 chars and unique, or pass id. For recurring: mode="single" (default, this occurrence), "following" (this and every later occurrence) or "all" (the whole series).',
            parameters: { type: 'object', properties: {
                search: { type: 'string' },
                id: { type: 'string' },
                from: { type: 'string', description: 'Search window start. Default: today.' },
                to: { type: 'string', description: 'Search window end. Default: today + 30 days.' },
                mode: { type: 'string', enum: ['single', 'following', 'all'] }
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
            name: 'daily_briefing',
            description: 'Get today\'s schedule, active projects, overdue tasks.',
            parameters: { type: 'object', properties: {} }
        }},

        // MEMORY — what nenva remembers about the person (MemoryManager,
        // rebuilt 2026-10-01): short facts under five headings. When-to-use
        // lives in the MEMORY domain guidance.
        { type: 'function', function: {
            name: 'save_memory',
            description: 'Remember one lasting fact about the user for future chats, as one short sentence, on a memory page. Saving with the same page and subject as an existing fact replaces it.',
            parameters: { type: 'object', properties: {
                text: { type: 'string', description: 'One short sentence about the user, e.g. "Works at Acme as a product manager"' },
                heading: { type: 'string', description: 'The memory page: about, people, work, preferences (how they want things done, what to never ask or nudge about), plans (ONLY something they intend to do and have not done yet; never something that already happened, a routine they follow or an instruction to you), email (what to show or skip from their email), or a short new page name when a topic has its own facts, e.g. "Kids school", "Health"' },
                subject: { type: 'string', description: 'A 1-3 word handle for what the fact is about, e.g. "employer", "partner", "diet" — reuse it when the fact changes' }
            }, required: ['text', 'heading'] }
        }},
        // recall_memory is deliberately NOT in the memory domain group (see
        // _toolGroups): personal questions ("what's my sister's name?")
        // carry no memory keyword, so it must be present on every turn.
        { type: 'function', function: {
            name: 'recall_memory',
            description: 'Search what you remember about the user (people, work, plans, preferences) with a few words. Returns matching facts with their ids.',
            parameters: { type: 'object', properties: {
                query: { type: 'string', description: 'A few words, e.g. "sister", "job", "running"' }
            }, required: ['query'] }
        }},
        { type: 'function', function: {
            name: 'update_memory',
            description: 'Correct a remembered fact when the user says it is wrong. Use the id from recall_memory.',
            parameters: { type: 'object', properties: {
                id: { type: 'string' },
                text: { type: 'string', description: 'The corrected sentence' }
            }, required: ['id', 'text'] }
        }},
        { type: 'function', function: {
            name: 'delete_memory',
            description: 'Forget a remembered fact. Only when the user asks you to forget it. Use the id from recall_memory.',
            parameters: { type: 'object', properties: {
                id: { type: 'string' }
            }, required: ['id'] }
        }},

        // LIBRARY tools (search_library / read_library_doc) are registered
        // by the Documents package (js/apps/reader/library-tools.js).

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
            description: 'Begin the guided intake that turns a conversation into a routine — something nenva does on its own. Returns the fixed agenda (what it should do, when it runs, answer-vs-actions, sources), the reason each topic matters, and the user\'s existing routines for context. Call this FIRST whenever the user wants help setting up a routine or automation, asks what routines can do, or wants one but hasn\'t specified the pieces — the agenda is fixed, do not improvise your own questions. When the user has already dictated a complete routine, skip this and call create_routine directly.',
            parameters: { type: 'object', properties: {} }
        }},
        { type: 'function', function: {
            name: 'create_routine',
            description: 'Create a ROUTINE — something nenva does on its own when a trigger fires: on a schedule, when a matching email arrives, or when a new file lands in a folder. Use whenever the user wants something recurring or automatic ("every morning…", "weekly digest of…", "whenever an invoice email arrives…"). The prompt must be a complete standalone instruction with every stated preference baked in. For an email or file trigger, each matching thing fires its OWN run and the run context names it (the email\'s id, the file\'s path) — so write the prompt about "the email/file that triggered this run" and NEVER as a search ("search the mailbox for invoices…" re-does every earlier match\'s work each fire). Two run modes: "digest" (default) answers it read-only and posts the answer into the routine\'s own chat; "task" runs a multi-step task that may CHANGE things, pausing for permission when a step needs it — its run log stays on the routine\'s page (Run history). Choose "task" only when the request needs actions taken, not just an answer written. NOT a routine: something the PERSON does at a time ("remind me to call the lawyer Friday at 3") is a commitment (add_commitment); a morning overview of their day is their Now page, which already exists (say so, create nothing). Always pass saysBack (the one sentence they confirm) and tells.',
            parameters: { type: 'object', properties: {
                title: { type: 'string', description: 'Short name, e.g. "Staff+ job digest"' },
                prompt: { type: 'string', description: 'The full instruction to run each time, self-contained — include all the user\'s stated preferences and criteria.' },
                trigger: { type: 'object', description: 'What starts it. One of: {"type":"time","interval":"hourly|6h|daily|weekdays|weekly","time":"HH:MM"} (weekdays = Mon–Fri; "every morning" → "08:00"; omit time for hourly/6h) · {"type":"email","from":"...","subject":"...","contains":"..."} (case-insensitive substring match on the sender, the subject line, and the whole message text respectively; at least one. Use `contains` for "an email WITH an invoice / a receipt in it" — subject-only would miss a mail whose subject never says the word) · {"type":"file","folder":"~/...","pattern":"*.pdf"}' },
                runMode: { type: 'string', enum: ['digest', 'task'], description: 'digest = write me an answer (default); task = take actions' },
                web: { type: 'boolean', description: 'Allow web search during runs — needed for anything based on outside data (jobs, news, prices). Digest mode only.' },
                useContext: { type: 'boolean', description: 'Run with the user\'s personal context (memory, projects, schedule). Digest mode only.' },
                about: { type: 'array', description: 'The records this routine is ABOUT, as [{"type":"goal","id":"..."}] — a project it reviews, a ticker or account it watches, a document it reads. Resolve ids with the record\'s own list tool first; never invent one. Each named record\'s own context is carried into every run, the record\'s page can show the routine, and the link survives either side being renamed.', items: { type: 'object', properties: { type: { type: 'string' }, id: { type: 'string' } }, required: ['type', 'id'] } },
                tells: { type: 'string', enum: ['change', 'each'], description: '"change": a watch, it tells them only when what it watches changes ("keep track of", "tell me when"). "each": a delivery, it brings something every run (a roundup, a review), covering only what is new. Not needed for watcher "mail" (every message it is about is news).' },
                saysBack: { type: 'string', description: 'What nenva will do and when it will tell them, as the end of a sentence that starts "I\'ll", addressed to them ("you", "your", never "my" or "me"), with nothing about how often (no "daily", "each morning", "each time it runs"): the app puts the schedule in front of it, e.g. "check the visa bulletin and tell you only when the EB-2 or EB-3 dates change". The person confirms this sentence with one tap.' },
                watcher: { type: 'string', enum: ['mail', 'money'], description: 'Set when nenva ALREADY watches what this is about, so the routine becomes an instruction that watcher follows instead of a second reader. "mail": its mail and texts are read as they arrive, e.g. "tell me right away when the USPTO writes about my trademark" (no trigger needed). "money": the money coach follows it on its looks, e.g. "tell me when a Core Growth sleeve leaves its band"; give a time trigger only when the person named a time ("every weekday at 8"). Omit for anything nothing watches (a web page, a price, a public list, news).' }
            }, required: ['prompt'] }
        }},
        { type: 'function', function: {
            name: 'list_routines',
            description: 'List the user\'s routines — what nenva runs on its own (each is a Standing chat; a digest posts its answer into that chat, an action run keeps its log on the routine\'s Run history): id, title, prompt snippet, what triggers it, run mode, last run. Long prompt text is snipped — pass the routine\'s id when the answer depends on the full wording. Call this FIRST for any question about a routine\'s schedule, timing, or behavior — e.g. "why did my market review run at the wrong time".',
            parameters: { type: 'object', properties: {
                id: { type: 'string', description: 'One routine, with its full prompt text.' }
            } }
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
                about: { type: 'array', description: 'Replace the records this routine is about, as [{"type":"goal","id":"..."}]. Pass [] to clear.', items: { type: 'object', properties: { type: { type: 'string' }, id: { type: 'string' } }, required: ['type', 'id'] } },
                tells: { type: 'string', enum: ['change', 'each'], description: 'Tell only on a change (a watch) or each run (a delivery).' },
                saysBack: { type: 'string', description: 'The routine\'s one sentence, without the schedule (see create_routine).' },
                watcher: { type: 'string', enum: ['mail', 'money', ''], description: 'Make it an instruction to a watcher nenva already has ("mail" or "money", see create_routine), or "" to make it run on its own again.' }
            }, required: ['id'] }
        }},
        { type: 'function', function: {
            name: 'delete_routine',
            description: 'Delete a routine and stop its runs (its chat and past results go with it). Resolve id with list_routines first.',
            parameters: { type: 'object', properties: {
                id: { type: 'string' }
            }, required: ['id'] }
        }},

        // FILES + SHELL — act on the Mac's filesystem (docs/COWORK_AGENT.md
        // C3). Paths must be absolute or ~-based; ~/nenva (the content root) is
        // always allowed, anything else prompts the user for permission the first
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
            description: 'Hand a bigger job to nenva\'s team (2026-10-02: the workroom engine): use when the request needs several different actions in sequence (gather + create, cross-app work, multi-item web research — "find ten X and their contact info", operating a website). nenva brings in specialists (mail, calendar, tasks, notes, documents, web research, a browser, a writer) one at a time; they may create or update tasks, projects, events and notes, and the user approves each change in this chat. The job runs in the background, shows its progress under your reply and posts its answer into this chat. Do NOT use for a single action — just do it.',
            parameters: { type: 'object', properties: {
                goal: { type: 'string', description: 'The complete outcome the user wants, restated fully with the exact details (names, dates, places, quantities). The last few chat messages are attached automatically.' }
            }, required: ['goal'] }
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
     * READ tools → the kind of personal data they return. Not a gate on
     * what may leave this Mac (that setting is gone, 2026-10-10: AI work
     * goes to the chosen model whenever it is needed); a workroom that read
     * any of it is tainted before a web step. Packages add rows through
     * register's `dataClass`.
     */
    DATA_CLASS: {
        list_emails: 'email', get_email: 'email', list_email_analyses: 'email',
        read_email_attachment: 'email', scan_emails: 'email', search_gmail: 'email',
        find_contact: 'email',
        list_notes: 'notes', get_note: 'notes',
        read_url: 'browse',
        fs_read: 'files', fs_list: 'files', fs_search: 'files'
    },

    /**
     * Tool name → domain group. Tools not listed here fall into "core" and are
     * always included by definitionsFor(). Keep this in sync with definitions[].
     */
    _toolGroups: {
        // email
        list_emails: 'email', get_email: 'email', list_email_analyses: 'email',
        read_email_attachment: 'email',
        mark_email_read: 'email', archive_email: 'email', sync_older_emails: 'email',
        scan_emails: 'email', search_gmail: 'email',
        trash_email: 'email', send_email: 'email',
        // texts (iMessage via this Mac's Messages app)
        send_text: 'messages',
        // calendar
        list_calendar_events: 'calendar', create_calendar_event: 'calendar',
        update_calendar_event: 'calendar', delete_calendar_event: 'calendar',
        // portfolio: registered by its package, js/apps/portfolio/portfolio-tools.js
        // bookmarks: registered by its package, js/apps/bookmarks/bookmarks-tools.js
        // notes-write (list_notes + create_note are in core)
        update_note: 'notes', delete_note: 'notes',
        // memory
        update_memory: 'memory', delete_memory: 'memory',
        // recall_memory AND save_memory (2026-10-02) intentionally unmapped →
        // 'core': the briefing's memory page index must be actionable on every
        // turn, and a lasting fact is said without the word "remember" — with
        // save_memory scoped to that keyword, a reply said "Stored too" and
        // had nothing to store it with.
        // save_decision / list_decisions / delete_decision are also unmapped →
        // 'core' for the same reason: decisions get settled in ANY domain
        // conversation (a strategy chat, a goal chat), and the `decisions`
        // field riding on read results must be actionable when it appears.
        // routines (Prompt Feed)
        start_routine_interview: 'prompts',
        create_routine: 'prompts', list_routines: 'prompts',
        update_routine: 'prompts', delete_routine: 'prompts',
        // news: registered by its package, js/apps/news/news-tools.js
        // library: registered by the Documents package, js/apps/reader/library-tools.js
        // app help (the in-app user guide — help-docs.js) and what this Mac
        // has actually set up (accounts / model / search / sync)
        get_help: 'help', get_setup_status: 'help',
        // files + shell (C3; gated by the `agentfs` feature flag below)
        fs_list: 'files', fs_read: 'files', fs_search: 'files',
        fs_write: 'files', fs_mkdir: 'files', fs_trash: 'files', fs_move: 'files',
        run_command: 'shell', run_applescript: 'shell',
        list_shortcuts: 'shell', run_shortcut: 'shell',
        process_start: 'shell', process_status: 'shell',
        process_stop: 'shell', process_list: 'shell',
        // find_contact is core: email and text share it, including a lookup
        // before the user has chosen a sending tool group.
        // Core (anything not mapped): search_all, web_search, read_url,
        // daily_briefing, create_note, list_notes, get_note.
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
    /**
     * What each tool group is for, in a few words (the use_tools catalog).
     * A package's group not listed here is described by its tools' names.
     */
    get _builtinGroupInfo() { return this.__builtin || (this.__builtin = { email: 1, messages: 1, calendar: 1, updates: 1, notes: 1, memory: 1, prompts: 1, files: 1, shell: 1, help: 1 }); },
    GROUP_INFO: {
        email: 'search, read, archive and send email; the insights read from mail',
        messages: 'send a text (iMessage) to someone',
        calendar: 'read, create, move and delete calendar events',
        updates: 'post and read progress updates on projects and tasks',
        notes: 'read and write notes',
        memory: 'remember, recall and forget things about the person',
        prompts: 'routines: create, change and run things nenva does on its own (schedules, triggers on new mail or files)',
        files: 'read, write, move and organise files and folders on this Mac',
        shell: 'run terminal commands, Shortcuts and AppleScript to drive Mac apps',
        help: 'how nenva works, its settings, and what is set up'
    },
    // Groups that come together because their tools depend on each other: a
    // commitment carries an Updates log. Facts about the tools, not guesses
    // about the message.
    GROUP_IMPLIES: { commitments: ['updates'] },
    // Never loadable from chat: a routine's "say nothing" verb is handed to a
    // quiet-capable run directly.
    // workroom specialists' own browser tools are theirs alone.
    HIDDEN_GROUPS: new Set(['routine-quiet', 'workroom-browser']),
    /** Every loadable group (not core) with one line saying what it holds. */
    toolCatalog() {
        const byGroup = new Map();
        for (const d of this.definitions) {
            const name = d.function.name;
            const g = this._toolGroups[name] || 'core';
            if (g === 'core' || this.HIDDEN_GROUPS.has(g)) continue;
            if (!byGroup.has(g)) byGroup.set(g, []);
            byGroup.get(g).push(name);
        }
        return [...byGroup.entries()].sort((a, b) => a[0].localeCompare(b[0]))
            .map(([g, names]) => ({ group: g, info: this.GROUP_INFO[g] || names.slice(0, 6).join(', ') }));
    },
    /** The use_tools definition with the live catalog in its description. */
    useToolsDef() {
        const base = this.definitions.find(d => d.function.name === 'use_tools');
        const catalog = this.toolCatalog().map(c => `${c.group}: ${c.info}`).join('; ');
        const description = `Load more of your tools. You start with a few; these groups load on demand and stay loaded for the rest of the chat: ${catalog}. Whenever a request needs one of these (the person's email, calendar, tasks, notes, files, routines, an app of theirs…), call use_tools FIRST, then use the tools it loads. Never say you cannot do something, or that you have no access, before loading the group it needs.`;
        if (this._useToolsDesc !== description) {
            this._useToolsDesc = description;
            this._useToolsCached = { ...base, function: { ...base.function, description } };
        }
        return this._useToolsCached;
    },


    /* ----------------------------------------------------------------
     * Dynamic tool registration — bundled packages and connected tool servers
     * contribute through this registry (see docs/PLATFORM.md). The core
     * registry above stays static; dynamic tools are tracked in
     * _dynamicTools so their source can unregister them.
     * ---------------------------------------------------------------- */
    _dynamicTools: {},      // tool name -> { source, group, ask, describe, … } (see register)

    /**
     * SOURCE EXTRACTORS (2026-09-02): which records a READ tool's result
     * drew on, as `{key: '<app>:<id>', title}` entries — the "Sources" row
     * under an answer shows them as links, the way web pages appear for
     * web_search/read_url. Deterministic from the tool transcript, never
     * model-written (the sources rule). Core tools are listed here;
     * packages declare theirs through AgentTools.register `sources`.
     */
    _sourceExtractors: {
        get_note: (args, res) => (res && res.id) ? [{ key: `notes:${res.id}`, title: res.title || 'Note' }] : [],
        // search_all: only DOCUMENT hits carry content (a passage); note /
        // task hits are titles the model must still open.
        search_all: (args, res) => (Array.isArray(res?.results) ? res.results : [])
            .filter(r => r && r.app === 'reader' && r.kind === 'document' && r.id)
            .slice(0, 3)
            .map(r => ({ key: `librarydoc:${r.id}`, title: r.title || 'Document' }))
    },

    /** Records a tool result drew on (see _sourceExtractors). */
    sourcesFor(tool, args, result) {
        const fn = this._sourceExtractors[tool];
        if (typeof fn !== 'function' || !result || result.error) return [];
        try {
            return (fn(args || {}, result) || [])
                .filter(x => x && typeof x.key === 'string' && /^[a-z]+:.+/.test(x.key))
                .map(x => ({ key: x.key, title: String(x.title || '').slice(0, 160) }));
        } catch { return []; }
    },
    _recordLabels: {},      // app id -> pill word for records its tools write ('Wellness')
    _readOnlyTools: new Set(),  // registered with readOnly: true
    _webRunTools: new Set(),    // registered with webRun: true (routine web runs)

    /**
     * Register a tool at runtime — the ONE door through which an app package
     * package contributes to the assistant. Everything the
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
     *                  (legacy namespace, also used by MCP). A package names its own
     *                  ('wellness') so its tools ride that domain.
     *   keywords       a few words saying what the group is about: shown in the
     *                  use_tools catalog (never matched against messages —
     *                  AI native 2026-10-02: the model loads groups itself)
     *   domain         accepted for old callers and ignored
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
     *   dataClass      the kind of personal data this READ returns
     *                  (AgentTools.DATA_CLASS) — a workroom that read it is
     *                  tainted before any web step (workroom-engine.js)
     *   sources        (args, result) => [{key:'<app>:<id>', title}] — the
     *                  records a READ drew on, shown as source links under
     *                  the answer (AgentTools._sourceExtractors)
     *   With no group and no keywords the tool ships every turn ('core').
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

        const words = [...new Set((opts.keywords || []).map(k => String(k).trim()).filter(Boolean))];
        // The catalog line for a group with no description of its own.
        if (words.length && !this.GROUP_INFO[group]) this.GROUP_INFO[group] = words.slice(0, 8).join(', ');
        // A named group, or a user app's group with keywords, loads on
        // demand (use_tools); anything else ships every turn.
        this._toolGroups[name] = (opts.group || words.length) ? group : 'core';

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
        if (opts.dataClass) { this.DATA_CLASS[name] = opts.dataClass; meta.dataClass = true; }
        if (typeof opts.sources === 'function') { this._sourceExtractors[name] = opts.sources; meta.sources = true; }
        // Views of this tool's result (js/components/answer-blocks.js B1):
        // { id: (result, args) => block }. Built by the turn as the tool
        // runs; the model shows one with a ```nenva fence, never a number.
        if (opts.views && typeof opts.views === 'object') {
            const builders = {};
            for (const id of Object.keys(opts.views)) {
                if (/^[a-z][\w-]*$/i.test(id) && typeof opts.views[id] === 'function') builders[id.toLowerCase()] = opts.views[id];
            }
            if (Object.keys(builders).length) {
                this._viewBuilders = this._viewBuilders || {};
                this._viewBuilders[name] = builders;
                meta.views = true;
            }
        }
        return { ok: true };
    },

    /**
     * Views of one tool result (AnswerBlocks B1): every builder the tool
     * registered runs over the result it actually returned; one that
     * throws or returns nothing simply offers no view. → { viewId: block }.
     * Ids are per TURN (the model names a view, not a tool), so a later
     * tool's view of the same name replaces an earlier one.
     */
    buildViews(tool, args, result) {
        const out = {};
        const builders = this._viewBuilders && this._viewBuilders[tool];
        if (!builders || !result || typeof result !== 'object' || result.error) return out;
        if (typeof AnswerBlocks === 'undefined') return out;
        for (const id of Object.keys(builders)) {
            try {
                const block = AnswerBlocks.normalize(builders[id](result, args || {}));
                if (block) out[id] = Object.assign({ tool }, block);
            } catch (e) {
                console.warn(`[agent-tools] view ${tool}.${id} failed:`, e);
            }
        }
        return out;
    },

    /**
     * Kept so packages written before 2026-10-02 still load: a group's word
     * list no longer decides anything (AI native — the model loads groups
     * with use_tools). Ignored.
     */
    registerDomain() { return false; },

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
            if (meta.dataClass) delete this.DATA_CLASS[name];
        }
        for (const g of groups) {
            if (!Object.values(this._dynamicTools).some(m => m.group === g) && !(g in this._builtinGroupInfo)) delete this.GROUP_INFO[g];
        }
        return names.length;
    },

    /**
     * Return a scoped subset of tool definitions for the current user message.
     * Always includes the core group (~6 tools: search, web, daily_briefing,
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
    /**
     * The tools for a chat: core, use_tools (with the live catalog), and the
     * groups this chat has loaded (`domains` — conv.scopedDomains: loaded by
     * use_tools, seeded by a record or a caller). No word list decides.
     */
    definitionsFor(_unused, extraDomains) {
        const domains = new Set();
        if (Array.isArray(extraDomains)) {
            for (const d of extraDomains) {
                if (typeof d === 'string' && d) domains.add(d);
            }
        }
        return this.definitions.filter(d => {
            const group = this._toolGroups[d.function.name] || 'core';
            return group === 'core' || domains.has(group);
        }).map(d => d.function.name === 'use_tools' ? this.useToolsDef() : d);
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
        // Private chat: tools whose effect is to remember are refused here
        // as well as dropped from the tool list (js/agent/private-chat.js P3).
        if (ctx && ctx.private && typeof PrivateChat !== 'undefined' && PrivateChat.isBlockedTool(name)) {
            return PrivateChat.blockedResult(name);
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


    // ── Text messages (2026-09-10) ─────────────────────────────────────

    /**
     * What the prompt's context line and send_text know about iMessage on
     * this Mac. Cached so the (synchronous) context builder can read it;
     * refreshed on every build and from IMessageSource.init. "available"
     * means the user saved their own handle (iMessage card) or turned on
     * Insights from your texts — either proves Messages is set up here.
     */
    _imessageStatus: null,
    async imessageStatus(fresh) {
        if (!window.electronIMessage?.getStatus) return null;
        if (!fresh && this._imessageStatus) return this._imessageStatus;
        try {
            const st = await window.electronIMessage.getStatus();
            const insights = !!(typeof IMessageSource !== 'undefined' && IMessageSource.enabled && IMessageSource.enabled());
            const handle = (st && st.handle) || '';
            this._imessageStatus = { handle, insights, available: !!(handle || insights) };
        } catch { this._imessageStatus = null; }
        return this._imessageStatus;
    },

    /** The "me" forms send_text and the permission bound both accept. */
    SELF_HANDLE_RX: /^(me|myself|my\s+(own\s+)?(number|phone|imessage))$/i,

    /**
     * Recipient lookup is a read over existing sources, not a second address
     * book. Deduplicate destinations within a channel, never people by name.
     * Keep the full match count before limiting results so truncation cannot
     * turn an ambiguous name into an apparently unique recipient.
     */
    async findContacts({ query, channel } = {}) {
        const q = String(query || '').trim().toLowerCase();
        if (!q) return { error: 'find_contact needs a name, email address or phone number.' };
        if (!['email', 'text'].includes(channel)) return { error: 'Choose channel "email" or "text" from the user’s request; ask if unclear.' };
        const candidates = new Map();
        const normalize = value => {
            const s = String(value || '').trim().toLowerCase();
            return channel === 'text' && !s.includes('@') ? s.replace(/[\s()-]/g, '') : s;
        };
        const emailRx = /^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/;
        const add = (destination, name, source, date) => {
            const key = normalize(destination);
            if (!emailRx.test(key) && !(channel === 'text' && /^\+?\d{6,}$/.test(key))) return;
            let c = candidates.get(key);
            if (!c) {
                c = { destination: key, names: new Set(), sources: new Set(), lastSeen: 0 };
                candidates.set(key, c);
            }
            const label = String(name || '').trim();
            if (label) c.names.add(label);
            c.sources.add(source);
            const time = typeof date === 'number' ? date : Date.parse(date || '');
            if (Number.isFinite(time)) c.lastSeen = Math.max(c.lastSeen, time);
        };
        if (channel === 'email') {
            if (typeof EmailApp === 'undefined') return { error: 'Email is not loaded.' };
            await EmailApp.loadData();
            const own = new Set((EmailApp.accounts || []).map(a => normalize(a.email)));
            const addAddresses = (field, source, date, name) => {
                for (const a of EmailApp._parseAddresses(field)) {
                    if (!own.has(normalize(a.email))) add(a.email, name || a.name, source, date);
                }
            };
            for (const c of EmailApp.contacts || []) {
                addAddresses(c.email, c.manual ? 'saved_recipient' : 'email_header', null, c.name);
            }
            for (const e of EmailApp.emails || []) {
                // Only envelope fields, never bodies, signatures or AI insights.
                for (const field of [e.from, e.to, e.cc]) addAddresses(field, 'email_header', e.date);
            }
        } else {
            if (typeof IMessageSource === 'undefined' || !IMessageSource.enabled()) {
                return { error: 'Reading texts is off. Ask for the phone number or iMessage email.' };
            }
            for (const r of IMessageSource.records()) {
                const c = r && r.chat;
                if (c && !c.isGroup && c.handle) add(c.handle, c.name, 'text_conversation', r.date);
            }
        }
        const phoneQuery = channel === 'text' && /^\+?[\d ()-]+$/.test(q) ? normalize(q) : '';
        const matched = [...candidates.values()].filter(c => c.destination.includes(phoneQuery || q)
            || [...c.names].some(n => n.toLowerCase().includes(q)));
        const exact = c => c.destination === (phoneQuery || q) || [...c.names].some(n => n.toLowerCase() === q);
        matched.sort((a, b) => Number(exact(b)) - Number(exact(a)) || b.lastSeen - a.lastSeen || a.destination.localeCompare(b.destination));
        return {
            channel, total: matched.length, ambiguous: matched.length > 1,
            matches: matched.slice(0, 10).map(c => ({
                name: [...c.names][0] || '', destination: c.destination, sources: [...c.sources],
                ...(c.lastSeen ? { lastSeen: new Date(c.lastSeen).toISOString() } : {})
            })),
            note: matched.length > 1 ? 'Ask which destination the user means; do not choose by recency alone.'
                : matched.length ? 'Show this destination in the draft. A match is not identity verification or permission to send.'
                    : 'No match in the available history. Ask for the email address or phone number.'
        };
    },

    /**
     * Who a text goes to. Returns {handle, name} or {error}. "me" → the
     * handle saved in Settings › Connectors › Apple Messages; a phone number or
     * email passes through; anything else is a NAME looked up among the
     * 1:1 conversations the texts source has read — the only address book
     * this Mac has without asking for Contacts access. Ambiguity and
     * misses come back as errors the model relays as a question.
     */
    async resolveTextRecipient(raw) {
        const s = String(raw || '').trim();
        if (!s) return { error: 'send_text requires "to".' };
        const status = await AgentTools.imessageStatus(true);
        if (!status || !status.available) {
            return { error: 'iMessage is not set up on this Mac. The user can set it up in Settings › Connectors › Apple Messages — save their own number under Texts you send, or turn on Read my texts. Offer email instead.' };
        }
        if (AgentTools.SELF_HANDLE_RX.test(s)) {
            if (!status.handle) return { error: 'The user has not saved their own number: Settings › Connectors › Apple Messages holds it under Texts you send. Ask for the number, or offer email.' };
            return { handle: status.handle, name: 'you' };
        }
        if (/^(\+?[0-9][0-9 ()-]{5,}|[^\s@]+@[^\s@]+\.[^\s@]+)$/.test(s)) return { handle: s, name: '' };
        const found = await AgentTools.findContacts({ query: s, channel: 'text' });
        if (found.error) return found;
        if (found.total === 1) return { handle: found.matches[0].destination, name: found.matches[0].name };
        if (found.ambiguous) return { error: `Several recent conversations match "${s}". Ask which one, or use the number.`, matches: found.matches };
        return { error: `No phone number is known for "${s}". Ask the user for the number or iMessage email.` };
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
        if (typeof EmailApp === 'undefined') return { error: 'Email is not loaded.' };
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
        // Writable Apple calendars are destinations too (write-through,
        // 2026-09-09): {apple: true, calendarId, label}, named "apple:<title>".
        const appleCals = (typeof AppleImport !== 'undefined' && AppleImport.writableCalendars)
            ? AppleImport.writableCalendars().map(c => ({ apple: true, calendarId: String(c.id).replace(/^apple:/, ''), email: `apple:${c.summary}`, label: c.summary }))
            : [];
        const candidates = accounts.map(a => a.email).concat(appleCals.map(c => c.email));
        if (provided) {
            const target = String(provided).toLowerCase().trim();
            const match = accounts.find(a => (a.email || '').toLowerCase() === target);
            if (match) return { account: match };
            const bare = target.replace(/^apple:\s*/, '');
            const appleHits = appleCals.filter(c => target === 'apple' || c.label.toLowerCase() === bare || c.calendarId === bare || `apple:${c.calendarId}` === provided);
            if (appleHits.length === 1) return { account: appleHits[0] };
            if (appleHits.length > 1) {
                return { error: 'Several Apple calendars can be written. Name one with the "account" parameter.', candidates: appleHits.map(c => c.email) };
            }
            return {
                error: `Calendar account "${provided}" is not connected.`,
                candidates
            };
        }
        const all = accounts.concat(appleCals);
        if (all.length === 0) {
            return { error: 'No calendar accounts are connected. Connect Google in Settings → Connected Accounts, or turn on Apple Calendar under Settings → Accounts → Apple apps.' };
        }
        if (all.length === 1) return { account: all[0] };
        return {
            error: 'More than one calendar can be written to. Specify which one with the "account" parameter.',
            candidates
        };
    },

    /**
     * The calendar tools' `repeat` argument → an RRULE string, through the
     * Calendar app's own presets (CalendarApp.RRULES) so the assistant can
     * say exactly what the form's Repeat row can. Returns {rule: undefined}
     * when the argument was not passed, {rule: ''} for "none" (end the
     * series), {rule: 'RRULE:…'} for a preset, or {error}.
     */
    _calendarRepeatRule(repeat) {
        if (repeat === undefined || repeat === null || repeat === '') return { rule: undefined };
        const key = String(repeat).toLowerCase().trim();
        if (key === 'none') return { rule: '' };
        const rules = (typeof CalendarApp !== 'undefined' && CalendarApp.RRULES) || {};
        if (!rules[key]) return { error: `Unknown repeat "${repeat}". Use one of: none, ${Object.keys(rules).join(', ')}.` };
        return { rule: rules[key] };
    },

    // "HH:MM" of a naive local "YYYY-MM-DDTHH:MM[:SS]" string (what
    // parseAgentDateTime returns) — the clock that travels to a series.
    _clockOf(naiveIso) {
        const m = /T(\d{2}:\d{2})/.exec(String(naiveIso || ''));
        return m ? m[1] : null;
    },

    /**
     * Format a plain-text email body into HTML for the Gmail send bridge.
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
        // Tasks and projects are commitments: repaint the Commitments page if it shows.
        if (appName === 'schedule' || appName === 'goals') {
            if (AppManager.currentApp === 'commitments' && typeof CommitmentsPage !== 'undefined') CommitmentsPage.render();
            return;
        }
        if (appName === 'email') { EmailApp.refresh(); return; }
        const appMap = {
            notes: () => { NotesApp.loadNotes(); NotesApp.render(); },
            calendar: () => { CalendarApp.loadData(); CalendarApp.render?.(); }
        };
        if (AppManager.currentApp === appName && appMap[appName]) {
            appMap[appName]();
        }
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

        // search_gmail hits this session: id → account, so a hit that is not in
    // the local mailbox can still be read (get_email, read_email_attachment).
    _remoteEmailAccounts: new Map(),

    _rememberRemoteEmail(id, account) {
        if (!id || !account) return;
        const m = AgentTools._remoteEmailAccounts;
        m.delete(id);
        m.set(id, account);
        if (m.size > 500) m.delete(m.keys().next().value);
    },

    /** One message read straight from Gmail, never stored; null when unknown. */
    async _remoteEmail(id, account) {
        if (!id || !window.electronEmail?.getRemote) return null;
        const acct = account || AgentTools._remoteEmailAccounts.get(id);
        if (!acct) return null;
        try {
            const r = await window.electronEmail.getRemote(acct, id);
            return r && !r.error && r.email ? r.email : null;
        } catch { return null; }
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
        await EmailApp.loadData();
        let pool = EmailApp.getProfileEmails() || [];

        if (args.account) {
            const want = String(args.account).toLowerCase();
            pool = pool.filter(e => (e.account || '').toLowerCase() === want);
        }

        // Folder filter over the shared email cache
        const folder = (args.folder || 'inbox').toLowerCase();
        const labelMap = {
            inbox: 'INBOX', archive: 'ARCHIVE',
            trash: 'TRASH', sent: 'SENT'
        };
        if (folder === 'unread') {
            pool = pool.filter(e => !e.isRead && !(e.labels || []).includes('TRASH'));
        } else if (folder === 'priority') {
            pool = pool.filter(e =>
                EmailApp.isPrioritySender(e) &&
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
        return this._withUpdates(result, mounts);
    },

    /**
     * The Updates half of the same attach: the newest few updates on each
     * mounted project/task (`updates`, newest first, with who and when) and
     * `daysSinceUpdate`, so a review can say "quiet for three weeks"
     * without a second call. Same shared budget idea, smaller: history, not
     * instructions. Called from _withDecisions, which already gated on
     * ctx.untrusted before reaching here.
     */
    _withUpdates(result, mounts) {
        if (typeof UpdateStore === 'undefined' || !result || result.error) return result;
        let budget = 1800;
        const PER_ITEM = 240;
        const PER_MOUNT = 3;
        for (const m of (mounts || [])) {
            if (!m || !m.key || !m.into || !/^(goal|task):/.test(m.key)) continue;
            const list = UpdateStore.listFor(m.key);
            if (!list.length) continue;
            const items = [];
            for (const u of list.slice(0, PER_MOUNT)) {
                const cap = Math.min(PER_ITEM, budget);
                if (cap < 80) break;
                const text = u.body.length > cap ? u.body.slice(0, cap) + '…' : u.body;
                budget -= text.length;
                items.push({ id: u.id, postedAt: u.createdAt, by: u.source === 'ai' ? 'assistant' : 'user', kind: u.kind, text });
            }
            if (!items.length) continue;
            m.into.updates = items;
            m.into.daysSinceUpdate = UpdateStore.daysSince(list[0].createdAt);
            if (list.length > items.length) {
                const sep = m.key.indexOf(':');
                m.into.updatesMore = `${list.length - items.length} more — list_updates type=${m.key.slice(0, sep) === 'goal' ? 'project' : 'task'} id=${m.key.slice(sep + 1)}`;
            }
        }
        return result;
    },

    handlers: {
        find_contact(args, ctx = {}) {
            if (ctx.untrusted) return { error: 'Contact lookup is unavailable when reading untrusted content.' };
            return AgentTools.findContacts(args);
        },
        // ── META ──

        /**
         * No-op reasoning tool. Records the thought for debugging via
         * console + LLMLogger but has no other side effect. Pattern from
         * Anthropic's "think" tool post (Mar 2025) — gives the model an
         * explicit place to slow down before destructive actions or when
         * processing large tool results, without paying the latency tax
         * of always-on extended thinking.
         */
        /** Load tool groups into this chat (they stay for the rest of it). */
        use_tools({ groups } = {}, ctx = {}) {
            const known = new Map(AgentTools.toolCatalog().map(c => [c.group, c]));
            const asked = (Array.isArray(groups) ? groups : [groups]).map(g => String(g || '').trim().toLowerCase()).filter(Boolean);
            const ok = [...new Set(asked.filter(g => known.has(g)).flatMap(g => [g, ...(AgentTools.GROUP_IMPLIES[g] || [])]))].filter(g => known.has(g));
            const unknown = asked.filter(g => !known.has(g));
            if (!ok.length) return { error: `No such tool group${unknown.length ? `: ${unknown.join(', ')}` : ''}. Groups: ${[...known.keys()].join(', ')}.` };
            const conv = typeof AgentService !== 'undefined' && ctx.convId ? (AgentService.conversations || []).find(c => c.id === ctx.convId) : null;
            if (conv) {
                const set = new Set(Array.isArray(conv.scopedDomains) ? conv.scopedDomains : []);
                for (const g of ok) set.add(g);
                conv.scopedDomains = [...set];
            }
            const tools = AgentTools.definitions.filter(d => ok.includes(AgentTools._toolGroups[d.function.name])).map(d => d.function.name);
            let guidance = '';
            try { guidance = typeof AgentService !== 'undefined' && AgentService._domainGuidanceFor ? AgentService._domainGuidanceFor(ok, { ownBrowser: !!(conv && conv.ownBrowser) }) : ''; } catch { guidance = ''; }
            return { loaded: ok, tools, ...(unknown.length ? { unknown } : {}), ...(guidance ? { how_to_use: String(guidance).slice(0, 4000) } : {}), note: 'These tools are available now. Use them.' };
        },

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

            // Read the same main-owned connection state as Settings, on every
            // request. Google accounts and loaded tool groups cannot establish
            // OAuth status. Return only presence/status, never URLs or secrets.
            out.toolServers = { checked: false, servers: [], guidance: 'Connection status could not be checked. Do not infer disconnection from Google accounts or loaded tools.' };
            try {
                if (window.electronMCP?.listServers) {
                    const servers = await window.electronMCP.listServers();
                    if (!Array.isArray(servers)) throw new Error('Invalid connection status');
                    const providers = {
                        'https://mcp.slack.com/mcp': 'Slack',
                        'https://mcp.notion.com/mcp': 'Notion',
                        'https://mcp.linear.app/mcp': 'Linear'
                    };
                    out.toolServers = {
                        checked: true,
                        servers: servers.map(s => ({
                            name: s.name,
                            service: providers[s.url?.replace(/\/$/, '')] || 'Custom tool server',
                            enabled: !!s.enabled,
                            status: !s.enabled ? 'disabled' : s.auth === 'oauth' ? s.authStatus || 'unknown' : 'configured',
                            toolCount: Array.isArray(s.tools) ? s.tools.length : 0
                        })),
                        guidance: 'These connections are separate from Google accounts. Connected means signed in, even when no tools are cached or a server is idle. Configured custom servers are not live-tested here. Slack sign-in enables on-demand access; optional monitoring is separate.'
                    };
                }
            } catch { /* Unknown is not disconnected. Do not return raw IPC errors. */ }

            // The brain. `engine` is where it runs: llamacpp (this Mac),
            // server (the user's own), openai/anthropic (their own key).
            try {
                const entries = (typeof AgentService !== 'undefined' && AgentService.getModelList()) || [];
                const def = typeof AgentService !== 'undefined' ? AgentService.getDefaultEntry?.() : null;
                out.ai = {
                    configured: !!def,
                    defaultModel: def ? (AgentService.displayModelName(def) || null) : null,
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

            // Everything else Settings shows a person, so the assistant can
            // answer about it (docs/AI_NATIVE.md, 2026-10-08: whatever a
            // person can see, the assistant can read). Reads only: changing
            // any of these is the person's, in Settings. Each part is
            // independent; one that fails is left out, never guessed.

            // Every source and what the person's AI may see of it — the
            // Privacy page's own sentences (Sources.privacyLines).
            try {
                if (typeof Sources !== 'undefined' && Sources.privacyLines) {
                    out.sources = Sources.privacyLines().map(s => ({ name: s.label, on: !!s.on, state: s.value || undefined, reads: s.reads || undefined, ai: s.ai || undefined }));
                }
            } catch { /* left out */ }


            // What left this Mac in the last 7 days: the ledger's rows (when,
            // which service, what kind), never content.
            try {
                if (typeof SimpleSettings !== 'undefined' && SimpleSettings.leftRows) {
                    const since = new Date(Date.now() - 7 * 86400000).toISOString();
                    const rows = SimpleSettings.leftRows(
                        typeof LLMLogger !== 'undefined' ? LLMLogger.logs : [],
                        typeof SearchLogger !== 'undefined' ? SearchLogger.logs : [],
                        { kindOf: (s) => SimpleSettings._kindOfSource ? SimpleSettings._kindOfSource(s) : null, kept: typeof AIActivity !== 'undefined' ? AIActivity.recent : [] }
                    ).filter(r => String(r.ts || '') >= since);
                    const byService = {};
                    for (const r of rows) byService[r.service] = (byService[r.service] || 0) + 1;
                    out.leftThisMac = { last7Days: rows.length, byService, recent: rows.slice(0, 15), note: 'A developer record (Settings › Advanced › Developer › Data activity); people are not shown it, so answer in words.' };
                }
            } catch { /* left out */ }

            // This month's nenva cloud and web search use (Connect's numbers).
            try {
                if (typeof PlanUsage !== 'undefined' && PlanUsage.fetch) {
                    const v = PlanUsage.view(await PlanUsage.fetch());
                    if (v.state === 'ok') {
                        out.plan = {
                            plan: v.plan, resets: v.resets || undefined,
                            cloudPercentUsed: v.ai.percent, backgroundPercent: v.ai.backgroundPercent || undefined,
                            searchesUsed: v.searches.used, searchAllowance: v.searches.allowance,
                            renews: (v.billing && v.billing.renews) || undefined, trialEnds: (v.billing && v.billing.trialEnds) || undefined
                        };
                    } else if (v.state === 'unused') out.plan = { plan: null, note: 'nenva cloud and its web search have not been used on this Mac.' };
                }
            } catch { /* left out */ }

            try {
                const b = await window.electronBackup?.getSettings?.();
                if (b) out.backup = { on: !!b.enabled, frequency: b.enabled ? b.frequency || undefined : undefined, lastBackup: b.lastBackup || null };
            } catch { /* left out */ }

            try {
                if (typeof AppManager !== 'undefined') out.lock = { on: !!AppManager.authEnabled, afterMinutesIdle: AppManager.authEnabled ? Number(AppManager.autoLockTimeout) || 5 : undefined };
            } catch { /* left out */ }

            try {
                if (typeof AnalyticsManager !== 'undefined' && AnalyticsManager.isEnabled) out.usageStatistics = { sharing: !!AnalyticsManager.isEnabled() };
            } catch { /* left out */ }

            try {
                const t = await window.electronTelegram?.getStatus?.();
                if (t) out.telegram = { setUp: !!t.configured, linked: !!t.chat, on: !!t.enabled };
            } catch { /* left out */ }

            try {
                const st = window.electronBackground?.state?.();
                if (st) out.background = { routinesPaused: !!st.paused, keepRunningInMenuBar: !!st.enabled, openAtLogin: !!st.openAtLogin };
            } catch { /* left out */ }

            try {
                const i = await window.electronSystem?.getInfo?.();
                if (i && i.appVersion) out.version = String(i.appVersion).replace(/^v/, '');
            } catch { /* left out */ }

            // Buttons: only for what is NOT set up. A door to a thing the
            // user already did is noise under an answer, and the whole point
            // of this tool is naming the gap.
            const ids = [];
            if (!out.accounts.connected) ids.push('connect-google');
            if (!out.ai.configured) ids.push('ai-models');
            if (!out.webSearch.enabled) ids.push('web-search');
            return AgentTools._withActions(out, ids);
        },

        // ── READ ──


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
                    // WHEN a note was written is half of what it means: notes
                    // are never revised for consistency, so two that disagree
                    // are usually one old and one current.
                    updated: n.modifiedAt || n.createdAt || undefined,
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
                created: note.createdAt || undefined,
                updated: note.modifiedAt || note.createdAt || undefined,
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

        async search_all(args, ctx) {
            const q = (args.query || '').trim();
            if (!q) return { results: [] };
            const results = GlobalSearch.data(q, 20).map(({ app, id, title, meta }) => ({
                app, id, title, ...(meta || {})
            }));
            // Documents match by CONTENT too (the index in main, semantic +
            // keyword) — a title/tag match alone missed "the lease I
            // uploaded" when the user asked about what it says. Only when
            // the Documents package is installed (the IPC exists either
            // way, but an uninstalled package has no reader to open hits).
            if (window.electronLibrary && typeof ReaderApp !== 'undefined') {
                try {
                    const res = await window.electronLibrary.search(q, { k: 6 });
                    const seen = new Set(results.filter(r => r.app === 'reader').map(r => r.id));
                    const tags = (typeof DocTags !== 'undefined') ? DocTags.all() : new Map();
                    for (const r of (res.results || [])) {
                        if (seen.has(r.docId)) continue;
                        seen.add(r.docId);
                        results.push({
                            app: 'reader', id: r.docId, title: r.title, kind: 'document',
                            ...(tags.get(r.docId)?.length ? { tags: tags.get(r.docId) } : {}),
                            snippet: String(r.text || '').slice(0, 160)
                        });
                    }
                } catch { /* the record hits still answer */ }
            }
            // A document hit makes this a documents conversation: seed the
            // library domain so the NEXT turn ships search_library /
            // list_documents / tag_document and the documents guidance
            // (read_library_doc is core already). Tools are fixed per turn,
            // so this is for the follow-up — the sticky-domain rule.
            if (ctx && ctx.convId && results.some(r => r.app === 'reader') && typeof AgentService !== 'undefined' && AgentService.addScopedDomains) {
                AgentService.addScopedDomains(ctx.convId, ['library']);
            }
            return { results };
        },

        // ── WRITE ──


        create_note(args, ctx) {
            // C8.1's truncation ladder falls back to {} args after a failed
            // retry, counting on tool validation to catch it — an empty
            // Untitled note is a silent wrong write, not a note.
            if (!String(args?.title || '').trim() && !String(args?.content || '').trim()) {
                return { error: 'create_note needs a title and content — the call arrived empty (it may have been cut off). Re-issue it with less content.' };
            }
            const data = StorageManager.get('notes') || {};
            const notes = data.notes || [];
            const now = new Date().toISOString();

            // Tags (2026-10-07, NoteTags NT2): existing tags in their own
            // spelling; with none matching, one new tag at most — the
            // assistant judged which fit, code keeps the list from growing
            // noisy.
            const picked = (typeof NoteTags !== 'undefined')
                ? NoteTags.resolve(args.tags, NoteTags.existing({ tags: StorageManager.get('tags'), notes: data }))
                : { tags: Array.isArray(args.tags) ? args.tags : [], dropped: [] };

            // Where it came from (2026-10-07): the chat that wrote it. The
            // editor's meta strip shows "From the chat …" with a door back
            // to it. A private chat is never saved, so there is nothing to
            // point at; a routine or job run has no chat and carries none.
            let origin = null;
            if (ctx && ctx.convId && !ctx.private && typeof AgentService !== 'undefined') {
                const conv = (AgentService.conversations || []).find(c => c.id === ctx.convId);
                if (conv && !conv.private) origin = { kind: 'chat', ref: conv.id, title: String(conv.title || '').trim() || null };
            }

            const newNote = {
                id: UIUtils.generateId(),
                title: args.title,
                content: AgentTools.mdToNoteHtml(args.content),
                tags: picked.tags,
                // Provenance type: assistant-written notes carry the
                // 'assistant' template (chip on the card, sidebar filter).
                template: 'assistant',
                ...(origin ? { origin } : {}),
                pinned: false,
                createdAt: now,
                modifiedAt: now
            };

            notes.unshift(newNote);
            StorageManager.set('notes', { notes });
            AgentTools.refreshApp('notes');

            return { success: true, note: { id: newNote.id, title: newNote.title, tags: newNote.tags, ...(origin ? { fromChat: origin.ref } : {}) },
                     ...(picked.dropped.length ? { tagsDropped: picked.dropped, tagsNote: 'Only existing tags, or one new tag, go on a note.' } : {}) };
        },

        // ── ACTIONS ──


        // ── EMAIL handlers ──────────────────────────────────────────────────

        async list_emails(args) {
            if (typeof EmailApp === 'undefined') return { error: 'Email is not loaded.' };
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
         * Gmail's own search over the whole mailbox (2026-10-10): archived
         * and older-than-synced mail included, nothing downloaded or stored.
         * Hits are remembered for this session (id → account) so get_email
         * and read_email_attachment can read one straight from Gmail.
         */
        async search_gmail(args) {
            if (typeof EmailApp === 'undefined') return { error: 'Email is not loaded.' };
            if (!window.electronEmail?.searchRemote) return { error: 'Gmail search is unavailable in this build.' };
            const query = String(args?.query || '').trim();
            if (!query) return { error: 'search_gmail requires "query".' };
            await EmailApp.loadData();
            let accounts = EmailApp.getAccounts().filter(a => !EmailApp._isDemoAccount(a));
            if (args.account) {
                const want = String(args.account).toLowerCase();
                accounts = accounts.filter(a => a.email.toLowerCase() === want);
            }
            if (!accounts.length) return { error: 'No matching connected Gmail account.' };
            const limit = Math.min(Math.max(parseInt(args.limit) || 20, 1), 50);
            const emails = [], errors = [];
            let more = false;
            for (const account of accounts) {
                const r = await window.electronEmail.searchRemote(account.email, { query, maxResults: limit });
                if (r?.error) { errors.push({ account: account.email, error: r.error }); continue; }
                if (r.more) more = true;
                for (const e of r.emails || []) {
                    AgentTools._rememberRemoteEmail(e.messageId, account.email);
                    emails.push(e);
                }
            }
            emails.sort((a, b) => Number(b.internalDate || 0) - Number(a.internalDate || 0));
            const local = new Set((EmailApp.getProfileEmails() || []).map(e => e.messageId));
            return {
                query,
                returned: emails.length,
                ...(more ? { note: 'More matches exist; narrow the query (from:, after:, before:) to see them.' } : {}),
                ...(errors.length ? { errors } : {}),
                emails: emails.map(e => ({
                    id: e.messageId,
                    account: e.account,
                    from: e.from,
                    subject: e.subject,
                    snippet: e.snippet,
                    date: e.date,
                    synced: local.has(e.messageId)
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
            if (typeof EmailApp === 'undefined') return { error: 'Email is not loaded.' };
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
            if (typeof EmailApp === 'undefined') return { error: 'Email is not loaded.' };
            const until = Date.parse(String(args?.until_date || '') + 'T00:00:00');
            if (isNaN(until)) return { error: 'until_date (YYYY-MM-DD) required' };
            await EmailApp.loadData();

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
            AgentTools.refreshApp('email');
            return { results };
        },

        async get_email(args, ctx) {
            if (typeof EmailApp === 'undefined') return { error: 'Email is not loaded.' };
            if (!args.id) return { error: 'get_email requires "id".' };
            await EmailApp.loadData();

            const pool = EmailApp.getProfileEmails() || [];
            // A registered insight source's record (an iMessage
            // conversation, id 'imsg:…') reads through the same door — the
            // insight detail and the task's source block point here.
            const email = pool.find(e => e.messageId === args.id) || EmailApp.sourceRecordById?.(args.id)
                || await AgentTools._remoteEmail(args.id, args.account);
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
                    note: 'No body is stored locally for this message (only headers/snippet synced). Tell the user to open it in Gmail (the record link opens it there); do not try to reach Gmail another way.'
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
            if (typeof EmailApp === 'undefined') return { error: 'Email is not loaded.' };
            if (!args?.id) return { error: 'read_email_attachment requires "id" (the email id).' };
            if (!window.electronEmail?.readAttachmentText) {
                return { error: 'Attachment reading is unavailable in this build.' };
            }
            await EmailApp.loadData();
            const email = (EmailApp.getProfileEmails() || []).find(e => e.messageId === args.id)
                || await AgentTools._remoteEmail(args.id, args.account);
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

        async list_email_analyses(args) {
            if (typeof EmailApp === 'undefined') return { error: 'Email is not loaded.' };
            await EmailApp.loadData();

            const analyses = EmailApp.getProfileAnalyses() || {};
            const emails = EmailApp.getProfileEmails() || [];
            const emailById = new Map(emails.map(e => [e.messageId, e]));

            const unreadOnly = args.unread_only !== false;
            const limit = Math.min(Math.max(parseInt(args.limit) || 20, 1), 100);

            const rows = Object.entries(analyses)
                .filter(([emailId, a]) => {
                    // "Unread" is the folder's state (docs/MATTERS.md §17): a message on a settled folder is dealt with.
                    if (unreadOnly && typeof Matters !== 'undefined' && Matters.forSource) { const m = Matters.forSource(emailId); if (m && m.state !== 'open') return false; }
                    return emailById.has(emailId);
                })
                .map(([emailId, a]) => {
                    const e = emailById.get(emailId);
                    const m = typeof Matters !== 'undefined' && Matters.forSource ? Matters.forSource(emailId) : null;
                    return {
                        emailId,
                        ...(m ? { matterId: m.id, matter: Matters.titleOf(m) } : {}),
                        from: e?.from,
                        subject: e?.subject,
                        priority: a.priority,
                        summary: a.summary,
                        actionItems: a.actionItems || [],
                        insights: a.insights || [],
                        analyzedAt: a.analyzedAt
                    };
                })
                .sort((a, b) => new Date(b.analyzedAt || 0) - new Date(a.analyzedAt || 0))
                .slice(0, limit);

            return { total: rows.length, analyses: rows };
        },

        async mark_email_read(args) {
            if (typeof EmailApp === 'undefined') return { error: 'Email is not loaded.' };
            if (!args.id) return { error: 'mark_email_read requires "id".' };
            await EmailApp.loadData();

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
            await EmailApp._persistEmail(email);
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
            if (typeof EmailApp === 'undefined') return { error: 'Email is not loaded.' };
            if (!args.id) return { error: 'archive_email requires "id".' };
            await EmailApp.loadData();

            const email = (EmailApp.getProfileEmails() || []).find(e => e.messageId === args.id);
            if (!email) return { error: `No email with id "${args.id}" in the active profile.` };

            // Update the local cache and Gmail
            email.labels = (email.labels || []).filter(l => l !== 'INBOX');
            if (!email.labels.includes('ARCHIVE')) email.labels.push('ARCHIVE');
            await EmailApp._persistEmail(email);
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
            if (typeof EmailApp === 'undefined') return { error: 'Email is not loaded.' };
            if (!args.id) return { error: 'trash_email requires "id".' };
            await EmailApp.loadData();

            const email = (EmailApp.getProfileEmails() || []).find(e => e.messageId === args.id);
            if (!email) return { error: `No email with id "${args.id}" in the active profile.` };

            // Capture details before mutation so we can echo back
            const trashed = { id: email.messageId, subject: email.subject, from: email.from, account: email.account };

            // Update the local cache and Gmail
            email.labels = ['TRASH'];
            await EmailApp._persistEmail(email);
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

        /**
         * Text messages (2026-09-10): iMessage/SMS through this Mac's
         * Messages app, over the notification bridge's script. "me" is the
         * handle saved in Settings › Connectors › Apple Messages; a name resolves
         * against the 1:1 conversations "Insights from your texts" has
         * read. Consent: ASK_TOOLS, per send; a standing grant covers the
         * user's own number only (PermissionManager). Untrusted turns never
         * get it. The text is never logged in main.
         */
        async send_text(args) {
            if (!window.electronIMessage?.send) return { error: 'Text messages are not available in this build.' };
            const body = String(args.body || '').trim();
            if (!body) return { error: 'send_text requires a non-empty "body".' };
            const r = await AgentTools.resolveTextRecipient(args.to);
            if (r.error) return r;
            const res = await window.electronIMessage.send(r.handle, body);
            if (!res || res.error) {
                return { success: false, error: `Send failed: ${(res && res.error) || 'Messages did not send it'} Tell the user it was not sent.` };
            }
            // Main read the message back from Messages (2026-10-09): say
            // only what it saw. Anything short of delivered/sent is not
            // proof the text arrived.
            const channel = res.service === 'SMS' ? 'sms' : 'imessage';
            const sent = { to: r.handle, name: r.name || '', body, channel };
            const notes = {
                delivered: 'Messages reports it delivered.',
                sent: channel === 'sms' ? 'Messages sent it as a text message (SMS).' : 'Messages sent it; delivery is not confirmed yet.',
                unconfirmed: 'Messages took it but has not confirmed it went out. Tell the user it was handed to Messages and to check there; do not say it was delivered.',
                unverified: 'nenva cannot read Messages on this Mac (Full Disk Access), so it could not check the text went out. Tell the user it was handed to Messages; do not say it was delivered.',
            };
            const status = notes[res.status] ? res.status : 'unverified';
            return { success: true, status, sent, note: [res.note, notes[status]].filter(Boolean).join(' ') };
        },

        async send_email(args) {
            if (typeof EmailApp === 'undefined') return { error: 'Email is not loaded.' };
            await EmailApp.loadData();

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

            // Keep sent recipients in contacts and followed senders
            for (const addr of EmailApp._parseAddresses([params.to, params.cc, params.bcc].join(','))) {
                EmailApp.addContact?.(addr.email, addr.name);
                EmailApp.addPrioritySenderIfNew?.(addr.email);
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

            // Connected Google accounts plus the Apple Calendar mirror.
            const accountEmails = new Set((CalendarApp.getAccounts() || []).map(a => a.email));
            let events = (CalendarApp.events || []).filter(e => accountEmails.has(e.account) || e.source === 'apple');

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
                timezone: localTimeZone() || undefined,
                note: 'Times are the user\'s local wall-clock time (offset included). Present them as given; do not convert.',
                total: events.length,
                returned: sliced.length,
                events: sliced.map(e => ({
                    id: e.id,
                    summary: e.summary,
                    start: calendarInstant(e.start, e.allDay),
                    end: calendarInstant(e.end, e.allDay),
                    when: calendarInstantLabel(e.start, e.allDay) || undefined,
                    allDay: !!e.allDay,
                    location: e.location || undefined,
                    description: e.description || undefined,
                    account: e.account,
                    calendarId: e.calendarId,
                    calendar: e.source === 'apple' ? (e.appleCalendar || 'Apple Calendar') : undefined,
                    source: e.source === 'apple' ? 'apple' : 'google',
                    recurringEventId: e.recurringEventId || undefined,
                    // Organizer, attendees with replies, the call, reminders,
                    // files, show-as… only what the event has (EventDetails).
                    ...(typeof EventDetails !== 'undefined'
                        ? EventDetails.facts(e, CalendarApp.descriptionToText(e.description),
                            { localZone: localTimeZone() || '' }) : {})
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

            // Build start / end objects in the shape Google Calendar expects
            // (the Apple branch below reuses them).
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
            // Repeat rides the Calendar form's presets (CalendarApp.RRULES).
            const repeatRes = AgentTools._calendarRepeatRule(args.repeat);
            if (repeatRes.error) return { error: repeatRes.error };
            const rrule = repeatRes.rule || null;

            if (resolved.account.apple) {
                if (Array.isArray(args.attendees) && args.attendees.length) {
                    return { error: 'Apple Calendar events written from here cannot carry attendees. Create it without attendees, or in a Google account.' };
                }
                const payload = {
                    calendarId: resolved.account.calendarId,
                    title: eventData.summary, notes: eventData.description, location: eventData.location,
                    allDay,
                    start: allDay ? startObj.date : startObj.dateTime,
                    end: allDay ? endObj.date : endObj.dateTime,
                };
                if (allDay && payload.end <= payload.start) payload.end = CalendarApp._nextYMD(payload.start);
                if (rrule) payload.rrule = rrule;
                const res = await AppleImport.writeEvent('create', payload);
                if (res?.error) return { success: false, error: `Create failed: ${res.error}` };
                AgentTools.refreshApp('calendar');
                const landed = (CalendarApp.events || []).find(e => e.source === 'apple' && e.appleExternalId === res.externalId);
                return {
                    success: true,
                    created: {
                        id: landed?.id || `${res.externalId}:${res.occurrenceStart}`,
                        summary: eventData.summary, start: startObj, end: endObj,
                        location: eventData.location || undefined,
                        repeat: rrule ? args.repeat : undefined,
                        account: resolved.account.email, calendar: resolved.account.label, source: 'apple'
                    }
                };
            }

            if (rrule) eventData.recurrence = [rrule];
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

            // A series lands as expanded instances (singleEvents=true), so
            // the master's id shows up as their recurringEventId, never as
            // a row of its own.
            const verified = newId
                ? (CalendarApp.events || []).find(e => e.id === newId || (rrule && e.recurringEventId === newId))
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
                    id: verified?.id || newId,
                    seriesId: rrule ? newId : undefined,
                    repeat: rrule ? args.repeat : undefined,
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
            const event = (CalendarApp.events || []).find(e => e.id === args.id && (accountEmails.has(e.account) || e.source === 'apple'));
            if (!event) return { error: `No calendar event with id "${args.id}".` };
            if (event.source === 'apple' && event.appleWritable === false) {
                return { error: `"${event.summary}" is on a read-only Apple calendar (${event.appleCalendar || 'Apple Calendar'}).` };
            }

            // Bail if there are no actual fields to change
            const changeKeys = ['summary', 'start', 'end', 'all_day', 'location', 'description', 'repeat', 'calendar'];
            if (!changeKeys.some(k => args[k] !== undefined)) {
                return { error: 'No fields to update. Pass at least one of: summary, start, end, all_day, location, description, repeat, calendar.' };
            }

            // Scope is a question only an occurrence of a series can be asked
            // (the UI's this/all prompt); anything else is a "this" edit.
            const scope = (String(args.scope || 'this').toLowerCase() === 'all' && event.recurringEventId) ? 'all' : 'this';

            // Repeat: the form offers its Repeat row for a standalone event
            // or a whole series whose rule the presets express, never for
            // one occurrence — the same three cases here.
            const repeatRes = AgentTools._calendarRepeatRule(args.repeat);
            if (repeatRes.error) return { error: repeatRes.error };
            const rrule = repeatRes.rule; // undefined = untouched, '' = end the series
            if (rrule !== undefined && event.recurringEventId && scope !== 'all') {
                return { error: 'One occurrence cannot change how the series repeats. Pass scope "all" to change the whole series.' };
            }

            // Calendar move: Apple only (EventKit moves an event between
            // calendars in place; Google would need a different API).
            let moveCalendarId = null;
            if (args.calendar !== undefined && args.calendar !== '') {
                if (event.source !== 'apple') return { error: 'Only Apple events can be moved to another calendar from here.' };
                const want = String(args.calendar);
                const r = AgentTools.resolveCalendarAccount(/^apple(:|$)/i.test(want) ? want : `apple:${want}`);
                if (r.error) return r;
                if (!r.account.apple) return { error: `"${want}" is not an Apple calendar.` };
                moveCalendarId = r.account.calendarId;
            }
            if (scope === 'all' && args.all_day !== undefined && !!args.all_day !== !!event.allDay) {
                return { error: 'An all-day change applies to one occurrence, not a series. Pass scope "this".' };
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

            if (event.source === 'apple') {
                if (rrule !== undefined && scope === 'all' && CalendarApp._repeatFromRecurrence(event.recurrence) === null) {
                    return { error: 'This series repeats by a rule the presets cannot express, so its repeat cannot be changed from here. Change it in Calendar.' };
                }
                const payload = { externalId: event.appleExternalId, occurrenceStart: event.appleOccurrenceStart, span: scope };
                if (eventData.summary !== undefined) payload.title = eventData.summary;
                if (eventData.description !== undefined) payload.notes = eventData.description;
                if (eventData.location !== undefined) payload.location = eventData.location;
                if (moveCalendarId) payload.calendarId = moveCalendarId;
                if (rrule !== undefined) payload.rrule = rrule;
                if (eventData.start) {
                    const allDay = !!eventData.start.date;
                    if (scope === 'all') {
                        // The series keeps its dates; only the clock travels
                        // (CalendarApp._saveApple's "all" payload).
                        if (!allDay && !event.allDay) {
                            payload.startClock = AgentTools._clockOf(eventData.start.dateTime);
                            payload.endClock = AgentTools._clockOf(eventData.end.dateTime);
                        }
                    } else {
                        payload.allDay = allDay;
                        payload.start = allDay ? eventData.start.date : eventData.start.dateTime;
                        payload.end = allDay ? eventData.end.date : eventData.end.dateTime;
                        if (allDay && payload.end <= payload.start) payload.end = CalendarApp._nextYMD(payload.start);
                    }
                }
                if (scope === 'all' && Object.keys(payload).length === 3) {
                    return { error: 'Nothing in this edit applies to a whole series: a date or all-day change is per occurrence. Pass scope "this".' };
                }
                const res = await AppleImport.writeEvent('update', payload);
                if (res?.error) return { success: false, error: `Update failed: ${res.error}` };
                CalendarApp._recurrenceCache = {};
                AgentTools.refreshApp('calendar');
                const changes = { ...eventData };
                if (rrule !== undefined) changes.repeat = args.repeat;
                if (moveCalendarId) changes.calendar = args.calendar;
                return {
                    success: true,
                    updated: {
                        id: event.id, changes, source: 'apple',
                        scope: event.recurringEventId ? (scope === 'all' ? 'every occurrence (dates unchanged)' : 'this occurrence only') : undefined
                    }
                };
            }

            if (scope === 'all') {
                // Series-wide Google edit (CalendarApp._saveSeries): title,
                // details, location, repeat and the clock go to the master;
                // the date never does.
                const calendarId = event.calendarId || 'primary';
                const masterId = event.recurringEventId;
                const masterResult = await window.electronCalendar.getEvent(event.account, calendarId, masterId);
                if (masterResult?.error || !masterResult?.event) {
                    return { success: false, error: `Could not load the series: ${masterResult?.error || 'no master event'}`, needsReconnect: !!masterResult?.needsReconnect };
                }
                const master = masterResult.event;
                const data = {};
                if (eventData.summary !== undefined) data.summary = eventData.summary;
                if (eventData.description !== undefined) data.description = eventData.description;
                if (eventData.location !== undefined) data.location = eventData.location;
                const masterStartRaw = master.start?.dateTime;
                if (eventData.start?.dateTime && masterStartRaw && !event.allDay) {
                    const startClock = AgentTools._clockOf(eventData.start.dateTime);
                    const endClock = AgentTools._clockOf(eventData.end?.dateTime);
                    if (startClock) {
                        const [sh, sm] = startClock.split(':').map(Number);
                        const start = new Date(masterStartRaw);
                        start.setHours(sh, sm, 0, 0);
                        const timeZone = master.start?.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
                        data.start = { dateTime: start.toISOString(), timeZone };
                        if (endClock) {
                            const [eh, em] = endClock.split(':').map(Number);
                            const end = new Date(masterStartRaw);
                            end.setHours(eh, em, 0, 0);
                            if (end <= start) end.setDate(end.getDate() + 1);
                            data.end = { dateTime: end.toISOString(), timeZone };
                        }
                    }
                }
                if (rrule !== undefined) {
                    if (CalendarApp._repeatFromRecurrence(master.recurrence) === null) {
                        return { error: 'This series repeats by a rule the presets cannot express, so its repeat cannot be changed from here. Change it in Calendar.' };
                    }
                    data.recurrence = rrule ? [rrule] : [];
                }
                if (!Object.keys(data).length) {
                    return { error: 'Nothing in this edit applies to a whole series: a date or all-day change is per occurrence. Pass scope "this".' };
                }
                const result = await window.electronCalendar.updateEvent(event.account, calendarId, masterId, data);
                if (result?.error) {
                    return { success: false, error: `Update failed: ${result.error}`, needsReconnect: !!result.needsReconnect };
                }
                if (!result?.success && !result?.event) {
                    return { success: false, error: `Update did not return a confirmation event. Raw response: ${JSON.stringify(result)}` };
                }
                CalendarApp._recurrenceCache = {};
                await CalendarApp.syncEvents?.();
                AgentTools.refreshApp('calendar');
                const changes = { ...data };
                if (rrule !== undefined) changes.repeat = args.repeat;
                return { success: true, updated: { id: event.id, seriesId: masterId, changes, scope: 'every occurrence (dates unchanged)' } };
            }

            // A standalone event gaining or losing a rule: the server
            // expands a series into instances, so the local single row
            // would linger as a duplicate of the first occurrence (the
            // _performSave rule) — drop it and let sync bring the truth in.
            if (rrule !== undefined) eventData.recurrence = rrule ? [rrule] : [];

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
            if (rrule) {
                CalendarApp.events = (CalendarApp.events || []).filter(e => !(e.account === event.account && e.id === event.id));
                CalendarApp.saveData();
            }
            await CalendarApp.syncEvents?.();
            AgentTools.refreshApp('calendar');

            const changes = { ...eventData };
            if (rrule !== undefined) changes.repeat = args.repeat;
            return { success: true, updated: { id: event.id, changes } };
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
            let pool = (CalendarApp.events || []).filter(e => accountEmails.has(e.account) || (e.source === 'apple' && e.appleWritable !== false));

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
                            start: calendarInstant(e.start, e.allDay),
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
                                start: calendarInstant(e.start, e.allDay),
                                account: e.account
                            }))
                        };
                    }
                    target = partial[0];
                }
            }

            // "following" and "all" are questions only a series can be
            // asked; on a standalone event they mean the event itself.
            let mode = ['all', 'following'].includes(args.mode) ? args.mode : 'single';
            if (!target.recurringEventId) mode = 'single';
            const calendarId = target.calendarId || 'primary';
            const masterId = target.recurringEventId || target.id;
            const targetId = mode === 'all' ? masterId : target.id;

            const deleted = {
                id: target.id,
                summary: target.summary,
                start: calendarInstant(target.start, target.allDay),
                account: target.account,
                isRecurring: !!target.recurringEventId,
                mode
            };

            if (target.source === 'apple') {
                const res = await AppleImport.writeEvent('delete', {
                    externalId: target.appleExternalId, occurrenceStart: target.appleOccurrenceStart,
                    span: mode === 'all' ? 'all' : mode === 'following' ? 'future' : 'this'
                });
                if (res?.error) return { success: false, error: `Delete failed: ${res.error}` };
                CalendarApp._recurrenceCache = {};
                AgentTools.refreshApp('calendar');
                return { success: true, deleted: { ...deleted, source: 'apple' } };
            }

            // "following" trims the master's RRULE with an UNTIL just before
            // this occurrence (CalendarApp._deleteFollowingOccurrences —
            // the Calendar page's own arithmetic; falls back to deleting the
            // series when this is its first occurrence).
            const result = mode === 'following'
                ? await CalendarApp._deleteFollowingOccurrences(target, calendarId, masterId)
                : await window.electronCalendar.deleteEvent(target.account, calendarId, targetId);
            if (result?.error) {
                return { success: false, error: `Delete failed: ${result.error}`, needsReconnect: !!result.needsReconnect };
            }
            CalendarApp._recurrenceCache = {};

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
         * consent; removal writes a tombstone because notes are
         * record-merged and an untombstoned delete resurrects on sync.
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
                // A routine is not a note (a Standing chat since 2026-10-07):
                // stopping its runs is delete_routine's consent, not this one's.
                if (!target && typeof NotePrompts !== 'undefined' && NotePrompts.conversationOf(id)) {
                    return { error: `"${id}" is a routine, not a note — use delete_routine (id ${id}) so the user consents to stopping its runs.` };
                }
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
            // Removal with a tombstone: notes are record-merged and an
            // untombstoned delete resurrects on the next write.
            StorageManager.set('notes', { notes: notes.filter(n => n !== target), tombstones: { [target.id]: new Date().toISOString() } });
            if (typeof NotesApp !== 'undefined' && Array.isArray(NotesApp.notes)) NotesApp.notes = NotesApp.notes.filter(n => n.id !== target.id);
            AgentTools.refreshApp('notes');
            return { success: true, deleted: { id: target.id, title: target.title || 'Untitled note' } };
        },


        daily_briefing() {
            // From Commitments (2026-10-11): today's occurrences, what was
            // marked today, the overdue one-time ones, open goals and projects.
            const now = new Date();
            const timeLabel = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
            const C = typeof Commitments !== 'undefined' && Commitments._inited ? Commitments : null;
            const today = C ? C.today() : getDateStr(0);
            const all = C ? C.all().filter(c => c && c.title && !(c.privacySources || []).includes('slack')) : [];
            const happens = c => (C.repeats(c) ? C.occursOn(c, today) : !!(c.when && c.when.date === today));
            const marked = c => !!(c.history && c.history[today]) || (!C.repeats(c) && c.state !== 'open' && String(c.doneAt || '').slice(0, 10) === today);
            const timeOf = c => C.timeOn(c, today).time || '';
            const todayItems = all.filter(c => c.state === 'open' && happens(c) && !C.isDone(c, today) && !(c.history && c.history[today] === 'dropped'))
                .sort((a, b) => timeOf(a).localeCompare(timeOf(b)));
            const completedToday = all.filter(marked);
            const overdue = all.filter(c => c.state === 'open' && !C.repeats(c) && c.when && c.when.date && c.when.date < today)
                .sort((a, b) => a.when.date.localeCompare(b.when.date));
            const big = all.filter(c => c.state === 'open' && !c.parent && ['goal', 'project'].includes(C.kindOf(c, all)));
            const parentTitle = c => (c.parent && (all.find(p => p.id === c.parent) || {}).title) || undefined;
            return {
                today, currentTime: timeLabel,
                schedule: todayItems.map(c => ({ title: c.title, start: formatTime12h(timeOf(c)), partOf: parentTitle(c) })),
                completedCount: completedToday.length,
                overdue: overdue.slice(0, 10).map(c => ({ title: c.title, date: c.when.date })),
                goalsAndProjects: big.map(c => ({ title: c.title, kind: C.kindOf(c, all), by: c.by || undefined })),
                stats: {
                    goalsAndProjects: big.length,
                    tasksRemaining: todayItems.length,
                    completedToday: completedToday.length,
                    overdueCount: overdue.length
                }
            };
        },

        // ── MEMORY ──

        save_memory(args, ctx = {}) {
            // A preference's sentence carries its value (PrefAsks); written
            // here it would change the words and drop the value, so the app
            // would keep doing what the sentence says it won't (2026-10-08).
            if (/^pref:/i.test(String(args.subject || '').trim())) return { error: 'That is one of nenva\'s preferences: change it with set_preference (list_preferences shows the choices), which changes what the app does too.' };
            const res = MemoryManager.remember({
                text: args.text,
                heading: args.heading,
                newPage: true,
                subject: args.subject,
                convId: (typeof AgentService !== 'undefined' && AgentService.activeConversationId) || undefined,
                source: 'assistant'
            });
            if (res.error) return { error: res.error };
            const out = { success: true, id: res.fact.id, text: res.fact.text, status: res.status };
            if (res.was) out.replaced = res.was;
            return out;
        },

        recall_memory(args) {
            const query = String(args.query || args.page || '').trim();
            if (!query) return { error: 'query is required' };
            const hits = MemoryManager.search(query);
            return {
                count: hits.length,
                facts: hits.map(f => ({
                    id: f.id, text: f.text, heading: MemoryManager.headingLabel(f.heading),
                    ...(MemoryManager.asOfLabel(f) ? { asOf: MemoryManager.asOfLabel(f) } : {})
                })),
                ...(hits.length ? {} : { note: 'Nothing remembered matches — say you don\'t know rather than guess.' })
            };
        },

        update_memory(args) {
            const f = MemoryManager.get(String(args.id || '').trim());
            if (!f) return { error: 'no remembered fact with that id — recall_memory first' };
            if (f.meta && f.meta.pref) return { error: `That fact is the preference "${f.meta.pref}": change it with set_preference (list_preferences shows the choices), which changes what the app does too.` };
            const updated = MemoryManager.edit(f.id, { text: args.text });
            if (!updated) return { error: 'text is required' };
            return { success: true, id: updated.id, text: updated.text };
        },

        delete_memory(args) {
            const f = MemoryManager.forget(String(args.id || '').trim());
            if (!f) return { error: 'no remembered fact with that id — recall_memory first' };
            MemoryManager._forgotten.set(f.id, f);
            return { success: true, id: f.id, text: f.text };
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
                    runMode: cfg.runMode === 'task' ? 'task' : 'digest',
                    ...(cfg.watcher ? { watcher: cfg.watcher } : {}),
                    ...(cfg.saysBack ? { saysBack: cfg.saysBack } : {})
                };
            });
            return {
                instructions:
                    'Run this as an interview, not a form. Open with ONE short line on what a routine is ' +
                    '(nenva doing something for them on its own — on a schedule, when an email arrives, or ' +
                    'when a file lands) and offer the purpose examples so they have something to react to. ' +
                    'Then ask ONE topic at a time, in the order given, waiting for each answer: use `why` for ' +
                    'why it matters, `hint` for how to handle the answer. Derive what you can from what they ' +
                    'already said instead of re-asking it; skip a topic their words already answered. Do not ' +
                    'add topics of your own. The purpose topic decides where it belongs (a commitment, their ' +
                    'Now page, an instruction to the mail reader or the money coach, or a routine of its own); ' +
                    'create no routine for what belongs elsewhere. Nothing is saved as you go — the interview ' +
                    'ends with the review topic: one sentence said back (`saysBack`) and ONE create_routine ' +
                    'call; the app shows that sentence with its own reading of the schedule, and the person\'s ' +
                    'one tap is what turns it on. If they already have a similar routine (see existingRoutines), ' +
                    'say so and offer update_routine instead of a duplicate.',
                agenda: RoutineInterview.INTERVIEW.map(t => ({
                    id: t.id, question: t.question, why: t.why,
                    examples: t.examples, hint: t.hint
                })),
                nextTopic: RoutineInterview.topic('purpose'),
                context: {
                    today: getDateStr(0),
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
        create_routine(args) {
            if (typeof NotePrompts === 'undefined') return { error: 'Routines are unavailable' };
            const body = (args.prompt || '').trim();
            if (!body) return { error: 'prompt is required' };
            // A routine with no title shows up on Chats and its page as
            // "Untitled" — fall back to the prompt's first line, the
            // way the deleted handler did.
            const firstLine = body.split('\n')[0].trim();
            const title = (args.title || '').trim()
                || (firstLine.length > 70 ? firstLine.slice(0, 67).trimEnd() + '…' : firstLine);

            const watcher = ['mail', 'money'].includes(args.watcher) ? args.watcher : null;
            // An instruction to a watcher needs no trigger of its own: mail is
            // read as it arrives, the money coach looks on its own pace unless
            // the person named a time (docs/ROUTINES_UX.md I1, I2).
            // A mail instruction is read as mail arrives: any trigger given with
            // it (an email "from") is already in its sentence, so it is dropped.
            const t = (args.trigger && typeof args.trigger === 'object' && watcher !== 'mail') ? args.trigger
                : watcher ? { type: 'time', interval: 'daily', time: null } : {};
            const runMode = args.runMode === 'task' ? 'task' : 'digest';
            if (watcher && runMode === 'task') return { error: 'An instruction to a watcher (mail or money) only tells; it cannot be a task routine.' };
            if (runMode === 'task' && (typeof TeamJobs === 'undefined'
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
                // Pin execution to the Mac that armed it; the record itself
                // syncs to all of them (C10).
                homeMachineId: (typeof RoutineEngine !== 'undefined' && RoutineEngine._machineId) || null,
                // What it is ABOUT (js/apps/prompts/routine-about.js).
                // Normalized against the live RecordTypes registry, so an
                // invented type or a malformed entry is dropped rather than
                // stored — the reference is only worth having if it
                // resolves.
                about: (typeof RoutineAbout !== 'undefined') ? RoutineAbout.normalize(args.about) : [],
                watcher,
                // I9: what it tells and the sentence the person confirmed.
                // Every message a mail instruction is about is news: no watch/delivery choice there.
                tells: watcher !== 'mail' && ['change', 'each'].includes(args.tells) ? args.tells : null,
                saysBack: typeof args.saysBack === 'string' ? args.saysBack : null
            }});
            if (typeof RoutineEngine !== 'undefined') RoutineEngine.onRoutinesChanged();
            const cfg = NotePrompts.config(note);
            if (watcher) {
                return { success: true, id: note.id, title: note.title, watcher,
                    note: watcher === 'mail'
                        ? 'Your mail and texts are read with this instruction from now on: a message it is about is kept in a folder and told as it asks; what was done is noted in the routine\'s chat.'
                        : `The money coach follows this on its looks${t.time ? `, and looks for it ${NotePrompts.scheduleLabel(cfg)}` : ''}; what it raises for it shows on Now and in the routine's chat.` };
            }
            return {
                success: true, id: note.id, title: note.title,
                trigger: NotePrompts.triggerLabel(cfg), runMode,
                web: cfg.web, useContext: cfg.useContext,
                about: (typeof RoutineAbout !== 'undefined')
                    ? RoutineAbout.resolve(cfg.about).map(r => `${r.typeLabel}: ${r.label}`) : undefined,
                // "First run starts in a couple of minutes" is only true of a
                // SCHEDULE. An email/file routine waits for its trigger, and
                // telling the user to expect a post shortly would read as a
                // failure when nothing arrived.
                note: runMode === 'task'
                    ? 'Armed on this Mac. A step needing permission pauses and notifies rather than opening a dialog nobody is there to click. Each run keeps its log on the routine\'s page (Run history).'
                    : (t.type === 'time'
                        ? 'First run starts within a couple of minutes; each result lands in the routine\'s chat (Chats › Standing) and on Now.'
                        : 'Armed on this Mac. It runs when the trigger fires, and each run posts its answer into the routine\'s chat (Chats › Standing).')
            };
        },

        list_routines(args, ctx) {
            if (typeof NotePrompts === 'undefined') return { error: 'Routines are unavailable' };
            let prompts = NotePrompts.list().filter(n => NotePrompts.config(n).offline);
            const one = (args && args.id) ? String(args.id).trim() : '';
            if (one) {
                prompts = prompts.filter(n => n.id === one);
                if (!prompts.length) return { error: 'Routine not found — call list_routines for ids' };
            }
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
                        prompt: !one && body.length > PROMPT_SNIPPET
                            ? body.slice(0, PROMPT_SNIPPET) + `… (truncated — list_routines id=${n.id} for the full prompt)`
                            : body,
                        interval: cfg.interval, time: cfg.time,
                        trigger: NotePrompts.triggerLabel(cfg),
                        runMode: cfg.runMode,
                        web: cfg.web, useContext: cfg.useContext,
                        ...(cfg.watcher ? { watcher: cfg.watcher } : {}),
                        ...(cfg.tells ? { tells: cfg.tells } : {}),
                        ...(cfg.saysBack ? { saysBack: cfg.saysBack } : {}),
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
            if (args.watcher !== undefined) config.watcher = ['mail', 'money'].includes(args.watcher) ? args.watcher : null;
            if (args.tells !== undefined) config.tells = ['change', 'each'].includes(args.tells) ? args.tells : null;
            if (args.saysBack !== undefined) config.saysBack = typeof args.saysBack === 'string' ? args.saysBack : null;
            if (args.about !== undefined) {
                config.about = (typeof RoutineAbout !== 'undefined') ? RoutineAbout.normalize(args.about) : [];
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
                     about: (typeof RoutineAbout !== 'undefined')
                         ? RoutineAbout.resolve(cfg.about).map(r => `${r.typeLabel}: ${r.label}`) : undefined };
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

        // Chat jobs run on the workroom engine (2026-10-02, js/agent/team-jobs.js).
        // The task engine still serves routines that act, the CLI and recipes.
        async start_task(args, ctx) {
            if (typeof TeamJobs === 'undefined') return { error: 'Jobs are not available in this build.' };
            if (ctx && (ctx.private || ctx.unattended || ctx.ambient)) return { error: 'A job can only be started from an ordinary conversation.' };
            const convId = (ctx && ctx.convId) || ((typeof AgentService !== 'undefined') ? AgentService.activeConversationId : null);
            const res = await TeamJobs.start(args.goal, convId);
            if (res.error) return { error: res.error };
            return {
                ok: true,
                jobId: res.jobId,
                note: 'The job has started and is running now; its progress shows under your reply and its answer will be posted into this chat. END YOUR REPLY NOW with one short sentence saying you have started on it. Do not do the work yourself and do not give results yet.'
            };
        },

    },
};

// fs/shell tools ship behind the `agentfs` feature flag (docs/COWORK_AGENT.md
// phasing: every phase gets an isolated-instance pass before default-on).
// When off, the definitions and handlers are stripped so the model never
// sees the tools. For local development set featureFlags.agentfs in
// remote-config.json and run ANJADHE_REMOTE_CONFIG=local npm start.
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
    AgentTools.definitions = AgentTools.definitions.filter(d => d.function && d.function.name !== 'start_task');
    delete AgentTools.handlers.start_task;
}
