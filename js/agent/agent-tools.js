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
     * Notes the user linked to the portfolio (pseudo-item 'overview') or to
     * individual accounts (LinkManager, app 'portfolio'). Rides along in
     * list_portfolio so the user's own written thinking sits next to the
     * numbers without a separate lookup. Bodies are clipped; the id lets the
     * model get_note the rest.
     *
     * NOT the saved strategy — that is PortfolioStrategy, structured and
     * scoreable, surfaced separately in list_portfolio.
     */
    _portfolioStrategyNotes(accounts) {
        if (typeof LinkManager === 'undefined') return null;
        const allNotes = (StorageManager.get('notes')?.notes) || [];
        // Shared text budget across ALL notes: list_portfolio results are
        // hard-trimmed at resultMaxChars (6k), which destroys the JSON shape
        // — so past the budget, notes degrade to title + a get_note pointer
        // instead of blowing the cap.
        let budget = 3500;
        const PER_NOTE = 1200;
        const resolve = (itemId) => LinkManager.getLinksForApp('portfolio', itemId, 'notes')
            .map(l => allNotes.find(n => n.id === l.itemId))
            .filter(Boolean)
            .map(n => {
                const text = AgentTools._noteText(n);
                const cap = Math.min(PER_NOTE, budget);
                if (!text || cap < 200) {
                    return { id: n.id, title: n.title, text: text ? `(read with get_note id=${n.id})` : '' };
                }
                const clipped = text.length > cap
                    ? text.slice(0, cap) + `… (truncated — get_note id=${n.id} for the rest)`
                    : text;
                budget -= clipped.length;
                return { id: n.id, title: n.title, text: clipped };
            });
        const out = {};
        const overview = resolve('overview');
        if (overview.length) out.portfolio = overview;
        for (const a of (accounts || [])) {
            const notes = resolve(a.id);
            if (notes.length) (out.accounts = out.accounts || []).push({ account: a.name, notes });
        }
        return Object.keys(out).length ? out : null;
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
            name: 'list_focus',
            description: 'List focus areas with linked goals and tasks.',
            parameters: { type: 'object', properties: {} }
        }},
        { type: 'function', function: {
            name: 'list_goals',
            description: 'List goals, optionally filtered.',
            parameters: { type: 'object', properties: {
                due_within: { type: 'string', enum: ['today', 'week', 'month', 'year'], description: 'Only goals with a target date inside this horizon (overdue included)' },
                status: { type: 'string', enum: ['not-started', 'in-progress', 'no-progress', 'need-help'] },
                include_completed: { type: 'boolean' }
            }}
        }},
        { type: 'function', function: {
            name: 'list_schedule',
            description: 'List scheduled tasks/events. Pass filter matching user intent: "today", "tomorrow", "yesterday", "week", "all", or YYYY-MM-DD. Default: today. To find a specific task, pass search instead — it matches every date, immune to long-list truncation.',
            parameters: { type: 'object', properties: {
                search: { type: 'string', description: '1-3 distinctive keywords (e.g. "movie tickets") — case-insensitive word match on title/description, all dates' },
                filter: { type: 'string', description: '"today" | "tomorrow" | "yesterday" | "week" | "all" | YYYY-MM-DD' }
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
            description: 'Read one note\'s full content by id. Use this whenever the answer depends on what a note SAYS — list_notes and search_all give you the id and title, never the body. Returns up to 6000 chars; pass offset to continue a truncated note.',
            parameters: { type: 'object', properties: {
                id: { type: 'string', description: 'Note id from list_notes or search_all' },
                offset: { type: 'number', description: 'Character offset to continue from (default 0)' }
            }, required: ['id'] }
        }},
        { type: 'function', function: {
            name: 'list_journal',
            description: 'List journal entries; optional date range.',
            parameters: { type: 'object', properties: {
                date_from: { type: 'string', description: 'YYYY-MM-DD' },
                date_to: { type: 'string', description: 'YYYY-MM-DD' }
            }}
        }},
        { type: 'function', function: {
            name: 'log_wellness',
            description: 'Log a health entry in the Wellness app. kind decides which fields apply: bp (systolic, diastolic, pulse) · pulse = resting heart rate (value) · glucose (value, context) · spo2 (value %) · temperature (value) · weight (value) · activity (activityType, duration min, avgBpm, maxBpm) · steps (value) · meal (mealType, description) · water (amount) · sleep (hours, quality 1-5) · mood (mood/energy/stress 1-5) · medication (name, dose) · symptom (name, severity 1-5) · note (notes). Log meals/activities BEFORE a bp/glucose reading so the reading gets timing context.',
            parameters: { type: 'object', properties: {
                kind: { type: 'string', enum: ['bp', 'pulse', 'glucose', 'spo2', 'temperature', 'weight', 'activity', 'steps', 'meal', 'water', 'sleep', 'mood', 'medication', 'symptom', 'note'] },
                time: { type: 'string', description: 'Local time YYYY-MM-DDTHH:MM (or YYYY-MM-DD for sleep). Default: now.' },
                systolic: { type: 'number' }, diastolic: { type: 'number' }, pulse: { type: 'number' },
                value: { type: 'number', description: 'The measurement, for kinds pulse/glucose/spo2/temperature/weight/steps' },
                context: { type: 'string', description: 'Glucose timing: Fasting, Before meal, After meal, Bedtime, Random' },
                mealType: { type: 'string', description: 'Breakfast, Lunch, Dinner, Snack, Drink' },
                description: { type: 'string', description: 'What was eaten' },
                activityType: { type: 'string', description: 'Walk, Run, Strength training, Suryanamaskar, Yoga, Mindful breathing, Cycling, Swim, Sport, Other' },
                duration: { type: 'number' }, avgBpm: { type: 'number' }, maxBpm: { type: 'number' },
                amount: { type: 'number', description: 'Water amount, in the user\'s water unit' },
                hours: { type: 'number' }, quality: { type: 'number' },
                mood: { type: 'number' }, energy: { type: 'number' }, stress: { type: 'number' },
                name: { type: 'string', description: 'Medication or symptom name' },
                dose: { type: 'string' }, severity: { type: 'number' },
                notes: { type: 'string' }
            }, required: ['kind'] }
        }},
        { type: 'function', function: {
            name: 'list_wellness',
            description: 'List Wellness health entries, newest first. Blood pressure and glucose entries include the last meal and activity logged before them (with minutes elapsed) plus a BP category. Kinds: bp, pulse, glucose, spo2, temperature, weight, activity, steps, meal, water, sleep, mood, medication, symptom, note.',
            parameters: { type: 'object', properties: {
                kind: { type: 'string', description: 'Filter to one kind (omit for all)' },
                date_from: { type: 'string', description: 'YYYY-MM-DD' },
                date_to: { type: 'string', description: 'YYYY-MM-DD' },
                limit: { type: 'number', description: 'Max entries to return (default 20)' }
            }}
        }},
        { type: 'function', function: {
            name: 'wellness_summary',
            description: 'Wellness overview: latest blood pressure with category, 7/30-day BP averages, latest weight (with delta), latest glucose, last sleep, water today, mood today, and totals. Call this first for broad health questions.',
            parameters: { type: 'object', properties: {} }
        }},
        { type: 'function', function: {
            name: 'list_portfolio',
            description: 'Portfolio snapshot. include=overview (default): totals + top 5 holdings. include=full: per-account with price/gain/day%. Returns pricesAsOf for staleness, the user\'s saved strategy if they have one, and any notes they linked to the portfolio or its accounts.',
            parameters: { type: 'object', properties: {
                include: { type: 'string', enum: ['overview', 'full'], description: 'Default: overview' }
            }}
        }},
        { type: 'function', function: {
            name: 'get_ticker_detail',
            description: 'Deep dive on one ticker: shares by account, avg cost, current price, gain, day change. Use for single-stock questions instead of list_portfolio with full.',
            parameters: { type: 'object', properties: {
                ticker: { type: 'string' }
            }, required: ['ticker'] }
        }},
        { type: 'function', function: {
            name: 'refresh_portfolio_prices',
            description: 'Refresh market prices for all held tickers. No confirmation needed.',
            parameters: { type: 'object', properties: {} }
        }},
        { type: 'function', function: {
            name: 'get_strategy',
            description: 'Read the user\'s saved investment strategies. Omit name for all of them in brief; pass name for one in full (purpose, horizon, risk, approach, target mix, guardrails).',
            parameters: { type: 'object', properties: {
                name: { type: 'string', description: 'Strategy name (fuzzy match)' }
            }}
        }},
        { type: 'function', function: {
            name: 'check_strategy',
            description: 'Score the user\'s REAL holdings against a strategy: which sleeves drifted out of band, which guardrails are broken, what is not covered by the plan, and what it would take to get back. The app computes this — use these numbers, never your own. Call it for "am I following my plan", before advising on a trade, and right after saving a strategy.',
            parameters: { type: 'object', properties: {
                name: { type: 'string', description: 'Strategy name; default: the overall one' },
                accountName: { type: 'string', description: 'Score just this account against the strategy it follows' }
            }}
        }},
        { type: 'function', function: {
            name: 'start_strategy_interview',
            description: 'Begin or resume the guided intake that turns a conversation into a saved investment strategy. Returns the agenda, the next question to ask, and the user\'s current holdings for context. Call this FIRST whenever the user wants to create, build, or set up a strategy — the agenda is fixed, do not improvise your own questions.',
            parameters: { type: 'object', properties: {
                name: { type: 'string', description: 'Existing/draft strategy to continue; omit to start a new one' }
            }}
        }},
        { type: 'function', function: {
            name: 'save_strategy',
            description: 'Create or update an investment strategy. Merges — pass only the fields just agreed and call again as the interview proceeds, so an interrupted conversation still leaves a usable draft. Everything saved must be something the user actually said or explicitly approved. Returns what is still missing.',
            parameters: { type: 'object', properties: {
                name: { type: 'string', description: 'Strategy name — the key for create-or-update' },
                objective: { type: 'string', description: 'What the money is for, in the user\'s words' },
                horizon: { type: 'string', description: 'When they expect to need it, e.g. "20+ years"' },
                riskLevel: { type: 'string', description: 'The drop they said they could hold through, e.g. "about 30%"' },
                thesis: { type: 'string', description: 'How they want it invested and why' },
                coverage: { type: 'string', description: 'Which accounts this plan covers, e.g. "everything" or "the IRA and 401(k)"' },
                reviewCadence: { type: 'string', description: 'e.g. "quarterly"' },
                targets: { type: 'array', description: 'The target mix. Confirm the percentages with the user before saving.', items: { type: 'object', properties: {
                    label: { type: 'string', description: 'Sleeve name, e.g. "US index core"' },
                    tickers: { type: 'array', items: { type: 'string' }, description: 'Tickers in this sleeve (options match their underlying)' },
                    includeCash: { type: 'boolean', description: 'True for the cash sleeve' },
                    targetPct: { type: 'number' },
                    minPct: { type: 'number', description: 'Band floor; defaults to target-5' },
                    maxPct: { type: 'number', description: 'Band ceiling; defaults to target+5' }
                }}},
                rules: { type: 'array', description: 'Guardrails. kind max_position/min_cash/max_cash take value (a percent); avoid/only take tickers; custom takes text and is left for you to judge.', items: { type: 'object', properties: {
                    kind: { type: 'string', enum: ['max_position', 'min_cash', 'max_cash', 'avoid', 'only', 'custom'] },
                    value: { type: 'number' },
                    tickers: { type: 'array', items: { type: 'string' } },
                    exclude: { type: 'array', items: { type: 'string' }, description: 'max_position only: tickers the cap does not apply to. A position cap almost always means single stocks, so put broad index/bond funds here.' },
                    text: { type: 'string', description: 'The rule in the user\'s words' }
                }}},
                isDefault: { type: 'boolean', description: 'Make this the overall strategy accounts fall back to' },
                changeNote: { type: 'string', description: 'One line for the change log, e.g. "Raised cash floor to 10% after job change"' }
            }, required: ['name'] }
        }},
        { type: 'function', function: {
            name: 'assign_strategy',
            description: 'Set which strategy an account follows.',
            parameters: { type: 'object', properties: {
                accountName: { type: 'string' },
                strategyName: { type: 'string', description: 'Strategy to follow, or "overall" to fall back to the default one' }
            }, required: ['accountName', 'strategyName'] }
        }},
        { type: 'function', function: {
            name: 'get_news',
            description: 'Current headlines for the topics the user follows in the News app — real, dated, sourced articles they already chose to see. Prefer this over web_search for "what is the news", a news digest, or anything about their topics: it is one local read of an already-fetched list, and every headline is quoted from a real source rather than assembled from search snippets. Returns how long ago each story was published, so never describe an old story as breaking.',
            parameters: { type: 'object', properties: {
                topic: { type: 'string', description: 'Optional: only headlines for this topic. Must be one the user follows — the result lists them.' },
                limit: { type: 'number', description: 'Max headlines to return (default 20, max 40).' }
            }}
        }},
        { type: 'function', function: {
            name: 'web_search',
            description: 'Web search for info not in the user\'s data (news, current events, product specs, live stats). Returns {title, url, snippet}.',
            parameters: { type: 'object', properties: {
                query: { type: 'string', description: 'User\'s question verbatim; only rewrite to expand ambiguous abbreviations (CA→California) or add a year for time-bound queries.' },
                maxResults: { type: 'number', description: 'Default 5, max 10' }
            }, required: ['query'] }
        }},
        { type: 'function', function: {
            name: 'read_url',
            description: 'Fetch a web page and return its readable text (nav/ads stripped). Use AFTER web_search to read the 1–2 most promising results — snippets are often too thin to answer from — or when the user gives a URL. Pass `find` to center the excerpt on the part you need. If the result says truncated, call again with a sharper `find`.',
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
            description: 'Search across goals, notes, journal, tasks, bookmarks, focus areas and the wellness log. Results are ranked, best match first.',
            parameters: { type: 'object', properties: {
                query: { type: 'string' }
            }, required: ['query'] }
        }},
        { type: 'function', function: {
            // Enum stays in sync with HelpDocs.docs (help-docs.js) — the
            // handler validates against the live corpus, so a drifted enum
            // degrades to the index rather than erroring.
            name: 'get_help',
            description: 'The built-in Anjadhe user guide. Call for ANY question about Anjadhe itself — how to use a feature, where a setting lives, what something does — and answer from the returned doc, never from guesses about the UI. Topics: getting-started (first steps), your-day (Actions/Tasks/Plan), the-assistant (chat, memory, modes, background prompts), ai-models (local/server/API-key models, switching), ai-activity (what the AI engine is doing, GPU use, activity page), web-search (search keys), news (News page, topics), connected-accounts (Gmail/Calendar), everyday-apps (Notes/Journal/Bookmarks/Portfolio), how-anjadhe-works (privacy, sync, profiles, shortcuts, building apps), settings (map of every Settings section).',
            parameters: { type: 'object', properties: {
                topic: { type: 'string', enum: ['getting-started', 'your-day', 'the-assistant', 'ai-models', 'ai-activity', 'web-search', 'news', 'connected-accounts', 'everyday-apps', 'how-anjadhe-works', 'settings'], description: 'The closest topic. Omit to get the topic index.' }
            }}
        }},

        // WRITE
        { type: 'function', function: {
            name: 'create_goal',
            description: 'Create a measurable goal under a focus area. Pass focusTitle to link.',
            parameters: { type: 'object', properties: {
                title: { type: 'string' },
                description: { type: 'string' },
                targetDate: { type: 'string', description: 'Target date YYYY-MM-DD (optional)' },
                status: { type: 'string', enum: ['not-started', 'in-progress', 'no-progress', 'need-help'] },
                focusTitle: { type: 'string', description: 'Existing focus area title (fuzzy match)' }
            }, required: ['title'] }
        }},
        { type: 'function', function: {
            name: 'update_goal',
            description: 'Update a goal. Find by search (title) or id.',
            parameters: { type: 'object', properties: {
                search: { type: 'string' },
                id: { type: 'string' },
                new_title: { type: 'string' },
                status: { type: 'string', enum: ['not-started', 'in-progress', 'no-progress', 'need-help', 'completed'] },
                targetDate: { type: 'string', description: 'Target date YYYY-MM-DD, or "" to clear' },
                completed: { type: 'boolean', description: 'Shorthand for status: true = completed, false = in-progress' }
            }, required: ['search'] }
        }},
        { type: 'function', function: {
            name: 'update_schedule_item',
            description: 'Update a scheduled task/event. Find by search (title) or id.',
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
            name: 'create_schedule_item',
            description: 'Create a task/event. Only title is required; an untimed task is a plain to-do. Don\'t prompt for other fields.',
            parameters: { type: 'object', properties: {
                title: { type: 'string' },
                description: { type: 'string', description: 'Notes / details for the task (optional)' },
                startTime: { type: 'string', description: 'HH:MM (24h). Optional — omit for an untimed to-do.' },
                endTime: { type: 'string', description: 'HH:MM (24h)' },
                scheduledDate: { type: 'string', description: 'YYYY-MM-DD, or "today"/"tomorrow". Default: today.' },
                repeat: { type: 'string', enum: ['once', 'daily', 'weekdays', 'weekly'] },
                goalTitle: { type: 'string', description: 'Existing goal title to link (optional)' }
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
        { type: 'function', function: {
            name: 'create_journal_entry',
            description: 'Create a journal entry.',
            parameters: { type: 'object', properties: {
                content: { type: 'string' },
                mood: { type: 'string', enum: ['happy', 'sad', 'neutral', 'grateful', 'anxious'] },
                date: { type: 'string', description: 'YYYY-MM-DD. Default: today.' }
            }, required: ['content'] }
        }},
        { type: 'function', function: {
            name: 'add_transaction',
            description: 'Add a stock or option buy/sell to a portfolio account. Type "holding" records shares the user already owns (pricePerShare = their average cost) without affecting cash — use it for initial/existing positions. For a call/put option, ticker is the OCC symbol (underlying + YYMMDD + C/P + strike*1000 in 8 digits, e.g. AAPL261218C00250000), quantity is contracts, and pricePerShare is the per-share premium.',
            parameters: { type: 'object', properties: {
                accountName: { type: 'string' },
                type: { type: 'string', enum: ['buy', 'sell', 'holding'] },
                ticker: { type: 'string', description: 'Stock symbol, or OCC option symbol for calls/puts' },
                quantity: { type: 'number' },
                pricePerShare: { type: 'number' },
                date: { type: 'string', description: 'YYYY-MM-DD. Default: today.' },
                notes: { type: 'string' }
            }, required: ['accountName', 'type', 'ticker', 'quantity', 'pricePerShare'] }
        }},
        { type: 'function', function: {
            name: 'update_cash',
            description: 'Deposit, withdraw, or set cash for a portfolio account.',
            parameters: { type: 'object', properties: {
                accountName: { type: 'string' },
                amount: { type: 'number' },
                operation: { type: 'string', enum: ['deposit', 'withdraw', 'set'] }
            }, required: ['accountName', 'amount', 'operation'] }
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
            description: 'Get full contents of one email by id (from list_emails).',
            parameters: { type: 'object', properties: {
                id: { type: 'string' }
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
            description: 'Update a note. Find by search or id.',
            parameters: { type: 'object', properties: {
                search: { type: 'string' },
                id: { type: 'string' },
                new_title: { type: 'string' },
                content: { type: 'string', description: 'Replaces existing content' },
                append: { type: 'string', description: 'Appends to existing content' },
                tags: { type: 'array', items: { type: 'string' } }
            }, required: ['search'] }
        }},
        { type: 'function', function: {
            name: 'create_focus',
            description: 'Create a broad life category (Health, Career, Family, Finance, Learning). Call list_focus first; never for specific projects.',
            parameters: { type: 'object', properties: {
                title: { type: 'string' },
                description: { type: 'string' },
                goalTitles: { type: 'array', items: { type: 'string' }, description: 'Existing goal titles to link' }
            }, required: ['title'] }
        }},
        { type: 'function', function: {
            name: 'link_items',
            description: 'Link a goal to a focus area, or a task to a goal.',
            parameters: { type: 'object', properties: {
                type: { type: 'string', enum: ['goal_to_focus', 'task_to_goal'] },
                itemSearch: { type: 'string' },
                targetSearch: { type: 'string' }
            }, required: ['type', 'itemSearch', 'targetSearch'] }
        }},
        { type: 'function', function: {
            name: 'create_bookmark',
            description: 'Create a bookmark.',
            parameters: { type: 'object', properties: {
                url: { type: 'string' },
                title: { type: 'string', description: 'Auto-fetched if omitted' },
                description: { type: 'string' },
                group: { type: 'string' }
            }, required: ['url'] }
        }},
        { type: 'function', function: {
            name: 'daily_briefing',
            description: 'Get today\'s schedule, active goals, recent journal, overdue tasks.',
            parameters: { type: 'object', properties: {} }
        }},

        // MEMORY — persistent notes about the user across chats
        { type: 'function', function: {
            // When-to-use lives in the MEMORY domain guidance, which ships
            // whenever this tool does — not duplicated here.
            name: 'save_memory',
            description: 'Save a lasting fact or preference about the user for future chats. Dedupe automatic.',
            parameters: { type: 'object', properties: {
                type: { type: 'string', enum: ['preference', 'fact', 'context', 'correction'] },
                title: { type: 'string', description: 'Short label (optional; derived from body if omitted)' },
                body: { type: 'string', description: 'The memory content, first-person or third-person — stored verbatim.' }
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

        // BACKGROUND PROMPTS — recurring prompts run in the background on the
        // local model (PromptFeed); results post to the Home feed. The
        // conversational front door for the same prompt-notes the Feed's
        // "Manage prompts" UI edits.
        { type: 'function', function: {
            name: 'create_scheduled_prompt',
            description: 'Create a background prompt: it runs automatically on a recurring schedule and each run posts its result to the Home feed. Use when the user wants something regularly ("every morning…", "weekly digest of…"). The prompt must be a complete standalone instruction with every stated preference baked in.',
            parameters: { type: 'object', properties: {
                title: { type: 'string', description: 'Short feed label, e.g. "Staff+ job digest"' },
                prompt: { type: 'string', description: 'The full instruction to run each time, self-contained — include all the user\'s stated preferences and criteria.' },
                interval: { type: 'string', enum: ['hourly', '6h', 'daily', 'weekly'] },
                time: { type: 'string', description: 'HH:MM 24h run time for daily/weekly ("every morning" → "08:00", "every evening" → "18:00"). Omit for hourly/6h.' },
                web: { type: 'boolean', description: 'Allow web search during runs — needed for anything based on outside data (jobs, news, prices).' },
                useContext: { type: 'boolean', description: 'Run with the user\'s personal context (memory, goals, schedule).' }
            }, required: ['prompt', 'interval'] }
        }},
        { type: 'function', function: {
            name: 'list_scheduled_prompts',
            description: 'List the user\'s background prompts: id, title, prompt text, schedule, last run.',
            parameters: { type: 'object', properties: {} }
        }},
        { type: 'function', function: {
            name: 'update_scheduled_prompt',
            description: 'Change a background prompt\'s title, prompt text, or schedule. Resolve id with list_scheduled_prompts first. Omitted fields stay unchanged.',
            parameters: { type: 'object', properties: {
                id: { type: 'string' },
                title: { type: 'string' },
                prompt: { type: 'string', description: 'Replacement instruction (full text, not a diff)' },
                interval: { type: 'string', enum: ['hourly', '6h', 'daily', 'weekly'] },
                time: { type: 'string', description: 'HH:MM 24h run time for daily/weekly; pass "" to clear' },
                web: { type: 'boolean' },
                useContext: { type: 'boolean' }
            }, required: ['id'] }
        }},
        { type: 'function', function: {
            name: 'delete_scheduled_prompt',
            description: 'Delete a background prompt and stop its runs (past feed posts stay). Resolve id with list_scheduled_prompts first.',
            parameters: { type: 'object', properties: {
                id: { type: 'string' }
            }, required: ['id'] }
        }},

        // BUILD — the assistant is the one front door for building; these
        // dispatch to the Maker (artifacts) engine
        // (docs/COWORK_AGENT.md "Consolidating the three agents").
        { type: 'function', function: {
            name: 'list_creations',
            description: 'List the user\'s built apps and Maker artifacts with their ids. Call this first to resolve the target for edit_artifact.',
            parameters: { type: 'object', properties: {} }
        }},
        { type: 'function', function: {
            name: 'read_creation',
            description: 'Read the CURRENT files of a user-built app or Maker artifact (manifest + spec/code). Use when the user asks about the app or you need exact field/component names to plan a change. NOT required before edit_artifact — the build engine sees the files itself. Large files return in pages; pass offset to continue.',
            parameters: { type: 'object', properties: {
                appId: { type: 'string', description: 'App id from list_creations (for apps)' },
                artifactId: { type: 'string', description: 'Artifact id from list_creations (for artifacts)' },
                file: { type: 'string', description: 'Optional: read one file only (e.g. "app.js", "app.spec.json", "index.html")' },
                offset: { type: 'number', description: 'Character offset to continue a truncated file from' }
            } }
        }},
        { type: 'function', function: {
            name: 'create_artifact',
            description: 'Build a NEW self-contained web artifact — a research document, a slide-deck presentation, or a small interactive page (Maker engine). Use for reports, write-ups, presentations, one-off visualizations; the user can export any artifact to PDF from Maker. Slow (may take minutes); progress streams to the user.',
            parameters: { type: 'object', properties: {
                prompt: { type: 'string', description: 'What to research or build, in full detail.' }
            }, required: ['prompt'] }
        }},
        { type: 'function', function: {
            name: 'edit_artifact',
            description: 'Change an EXISTING Maker artifact. Resolve artifactId with list_creations first. Slow; progress streams to the user.',
            parameters: { type: 'object', properties: {
                artifactId: { type: 'string', description: 'Artifact id from list_creations' },
                prompt: { type: 'string', description: 'The change to make, in full detail.' }
            }, required: ['artifactId', 'prompt'] }
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
            description: 'Read a text file on the user\'s Mac. Returns up to 6000 chars; pass offset to continue a truncated file.',
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
            description: 'Start a MULTI-STEP task: use when the request needs several different actions done in sequence (organize, gather + create, cross-app work, or multi-item web research — "find ten X and their contact info" fans out over many searches). Produces a step plan the user approves; the task then runs itself and reports back. Do NOT use for a single action — just do it.',
            parameters: { type: 'object', properties: {
                goal: { type: 'string', description: 'The complete outcome the user wants, restated fully.' }
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
     * Tool name → domain group. Tools not listed here fall into "core" and are
     * always included by definitionsFor(). Keep this in sync with definitions[].
     */
    _toolGroups: {
        // email
        list_emails: 'email', get_email: 'email', list_email_analyses: 'email',
        mark_email_read: 'email', archive_email: 'email', sync_older_emails: 'email',
        scan_emails: 'email',
        trash_email: 'email', send_email: 'email', mark_analysis_read: 'email',
        // calendar
        list_calendar_events: 'calendar', create_calendar_event: 'calendar',
        update_calendar_event: 'calendar', delete_calendar_event: 'calendar',
        // schedule-write (list_schedule is in core)
        create_schedule_item: 'schedule', update_schedule_item: 'schedule',
        delete_schedule_item: 'schedule', complete_task: 'schedule',
        // portfolio
        list_portfolio: 'portfolio', get_ticker_detail: 'portfolio',
        refresh_portfolio_prices: 'portfolio', add_transaction: 'portfolio',
        update_cash: 'portfolio',
        get_strategy: 'portfolio', check_strategy: 'portfolio',
        start_strategy_interview: 'portfolio', save_strategy: 'portfolio',
        assign_strategy: 'portfolio',
        // goals / focus
        list_goals: 'goals', create_goal: 'goals', update_goal: 'goals',
        list_focus: 'goals', create_focus: 'goals', link_items: 'goals',
        // bookmarks
        create_bookmark: 'bookmarks',
        // journal
        list_journal: 'journal', create_journal_entry: 'journal',
        // wellness (health log)
        log_wellness: 'wellness', list_wellness: 'wellness', wellness_summary: 'wellness',
        // notes-write (list_notes + create_note are in core)
        update_note: 'notes',
        // memory
        save_memory: 'memory', list_memories: 'memory',
        search_memories: 'memory', delete_memory: 'memory',
        update_memory: 'memory', list_memory_pages: 'memory',
        // recall_memory intentionally unmapped → 'core': the briefing's memory
        // page index must be actionable on every turn, keyword or not.
        // background prompts (Prompt Feed)
        create_scheduled_prompt: 'prompts', list_scheduled_prompts: 'prompts',
        update_scheduled_prompt: 'prompts', delete_scheduled_prompt: 'prompts',
        // news (the user's followed topics — js/apps/news/news-feed.js)
        get_news: 'news',
        // app help (the in-app user guide — help-docs.js)
        get_help: 'help',
        // build (Maker artifacts)
        list_creations: 'build', read_creation: 'build',
        create_artifact: 'build', edit_artifact: 'build',
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
        if (/\b(tasks?|todos?|to-dos?|remind\w*|dues?|deadlines?|overdue)\b/.test(s) || /\bschedul\w+/.test(s)) out.add('schedule');
        // "plan" alone is far too common (meal plan, plan my day), so the
        // strategy phrasings are matched as phrases, not as a bare word.
        if (/\b(portfolios?|stocks?|tickers?|shares?|holdings?|invest\w*|net\s?worth|dividends?|strateg\w+|allocations?|rebalanc\w+|diversif\w+|asset\s?mix|risk\s?tolerance)\b/.test(s)
            || /\b(buy|sell)\b.*\b(shares?|stocks?)\b/.test(s)
            || /\b(on|off)[-\s]plan\b/.test(s)
            || /\b(following|follow|stick\w*\s+to|sticking\s+to)\s+(my|the)\s+plan\b/.test(s)
            || /\b(investment|financial|portfolio)\s+plans?\b/.test(s)
            || /\$[A-Z]{1,5}\b/.test(text)) out.add('portfolio');
        if (/\b(goals?|focus\s+areas?|priorit\w+)\b/.test(s)) out.add('goals');
        if (/\bbookmarks?\b/.test(s) || /save\s+(this\s+)?(link|url|page)/.test(s)) out.add('bookmarks');
        if (/\b(journals?|diar\w+|mood|feelings?)\b/.test(s)) out.add('journal');
        if (/\b(wellness|health|blood\s?pressure|bp|systolic|diastolic|pulses?|heart\s?rate|bpm|weight|weigh(ed|ing)?|glucose|blood\s?sugar|spo2|oxygen|temperatures?|fever|sleep|slept|hydration|water|meals?|ate|eating|medications?|meds?|vitamins?|supplements?|symptoms?|headaches?|workouts?|exercis\w+|breath\w+|steps|mood)\b/.test(s)) out.add('wellness');
        if (/\bnotes?\b/.test(s)) out.add('notes');
        if (/\b(remember|forget|recall|memor(y|ies)|\bprefer\w*|from\s+now\s+on|keep\s+in\s+mind|correct\w*)\b/.test(s)) out.add('memory');
        // Recurring intent → background prompts. Bare "morning"/"weekly" words
        // are too common, so require the every/each frame or an explicit
        // recurrence/feed word.
        if (/\b(every|each)\s+(day|morning|afternoon|evening|night|week|hour|(mon|tues|wednes|thurs|fri|satur|sun)day)\b/.test(s)
            || /\b(everyday|daily|weekly|hourly|recurring|regularly|digest|briefings?)\b/.test(s)
            || /\b(scheduled?|background)\s+prompts?\b/.test(s) || /\b(prompt\s*)?feed\b/.test(s)) out.add('prompts');
        if (/\b(news|headlines?|top\s+stories|current\s+events|world\s+news|press)\b/.test(s)) out.add('news');
        if (/\b(builds?|apps?|artifacts?|makers?|app\s*studio|trackers?|widgets?|dashboards?|creations?|presentations?|slides?|slideshows?|decks?|reports?|write-?ups?|one-?pagers?|infographics?|websites?|web\s?pages?|landing\s?pages?)\b/.test(s)) out.add('build');
        if (/\b(files?|folders?|director(y|ies)|desktop|downloads?|documents|finder|paths?|\.\w{2,4})\b/.test(s) || /~\//.test(text)) out.add('files');
        if (/\b(shell|terminal|command( line)?|commands|run|execute|git|zsh|bash|scripts?)\b/.test(s)
            // App-control intent → run_applescript (same 'shell' group):
            // driving other Mac apps by name, or classic automation verbs.
            || /\bshortcuts?\b/.test(s)
            || /\b(applescript|automat\w+|open|launch|quit|close)\b.*\b(app|apps|application|safari|finder|music|spotify|preview|pages|keynote|numbers|xcode|chrome)\b/.test(s)
            || /\b(play|pause|skip)\b.*\b(music|song|track|playlist)\b/.test(s)) out.add('shell');
        // App-usage questions → the get_help guide. "how do/can I" is broad
        // (matches generic how-tos too) but ships only one small schema, and
        // the domain prose keeps the model from calling it for non-app asks.
        if (/\b(settings?|configure|configuring|set ?up|setup|enable|disable|turn (on|off)|anjadhe|this app|the app|shortcuts?|profiles?|app lock|dark mode|onboard\w*|connect\w*)\b/.test(s)
            || /\bhow (do|can|does) (i|you|it)\b/.test(s) || /\bwhere (is|are|do|does|can)\b/.test(s)) out.add('help');
        // User-app tool groups (see register below): each group ships when
        // the message mentions the app's name/keywords.
        for (const group in this._dynamicDomainRes) {
            if (this._dynamicDomainRes[group].test(s)) out.add(group);
        }
        return out;
    },

    /* ----------------------------------------------------------------
     * Dynamic tool registration — user-built apps add assistant tools at
     * runtime via Anjadhe SDK `registerTool` (see docs/PLATFORM.md). The
     * built-in registry above stays static; dynamic tools are tracked in
     * _dynamicTools so they can be removed when their app reloads.
     * ---------------------------------------------------------------- */
    _dynamicTools: {},      // tool name -> { source }
    _dynamicDomainRes: {},  // group ('userapp:<id>') -> RegExp over keywords

    /**
     * Register a tool at runtime.
     * @param {object} definition - OpenAI-compatible: { type:'function', function:{ name, description, parameters } }
     * @param {function} handler - (args) => result | Promise<result>
     * @param {object} opts - { source: appId, keywords: string[] }
     *   keywords scope the tool into the prompt only when the user's message
     *   mentions the app (keeps prompt-eval fast on local models — see
     *   definitionsFor). With no keywords the tool ships every turn ('core').
     */
    register(definition, handler, opts = {}) {
        const fn = definition && definition.function;
        if (!fn || typeof fn.name !== 'string' || !fn.name || typeof handler !== 'function') {
            return { ok: false, error: 'register(definition, handler) needs a named function definition and a handler' };
        }
        if (this.handlers[fn.name]) {
            return { ok: false, error: `Tool "${fn.name}" already exists` };
        }
        const source = opts.source || 'dynamic';
        const group = `userapp:${source}`;
        const words = [...new Set((opts.keywords || [])
            .map(k => String(k).trim().toLowerCase())
            .filter(Boolean)
            .map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))];
        this.definitions.push(definition);
        this.handlers[fn.name] = handler;
        this._dynamicTools[fn.name] = { source, destructive: !!opts.destructive };
        if (words.length) {
            this._toolGroups[fn.name] = group;
            this._dynamicDomainRes[group] = new RegExp(`\\b(${words.join('|')})\\b`);
        } else {
            this._toolGroups[fn.name] = 'core';
        }
        return { ok: true };
    },

    /**
     * Remove every tool a given app registered. Used before re-mounting an
     * app (hot reload) so registrations don't pile up.
     */
    unregisterBySource(source) {
        const names = Object.keys(this._dynamicTools)
            .filter(n => this._dynamicTools[n].source === source);
        for (const name of names) {
            const idx = this.definitions.findIndex(d => d.function && d.function.name === name);
            if (idx !== -1) this.definitions.splice(idx, 1);
            delete this.handlers[name];
            delete this._toolGroups[name];
            delete this._dynamicTools[name];
        }
        delete this._dynamicDomainRes[`userapp:${source}`];
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
     */
    async execute(name, args) {
        const handler = this.handlers[name];
        if (!handler) {
            return { error: `Unknown tool: ${name}` };
        }
        try {
            return await handler(args || {});
        } catch (e) {
            return { error: e.message };
        }
    },

    /**
     * Dispatch a build to the Maker (artifacts) engine and bridge its
     * progress events into the assistant conversation via
     * AgentUI.onBuildProgress. Long-running: resolves only when the engine
     * finishes. The engine keeps its own reliability harness (verify→fix,
     * path containment) — the assistant is just the front door
     * (docs/COWORK_AGENT.md "Consolidating the three agents").
     */
    async _runBuild(kind, { prompt, artifactId = null }) {
        const text = (prompt || '').trim();
        if (!text) return { error: 'prompt is required' };

        // Captured at dispatch time; onBuildProgress drops events whenever
        // this stops being the visible conversation (same pattern as
        // onToolExecution).
        const convId = (typeof AgentService !== 'undefined') ? AgentService.activeConversationId : null;
        // BuildStatus keeps the timeline OUTSIDE the DOM so the chat page can
        // restore its progress card after navigation (the card/banners are
        // ephemeral UI).
        if (typeof BuildStatus !== 'undefined') BuildStatus.begin(kind, convId);
        const emit = (e) => {
            try { if (typeof BuildStatus !== 'undefined') BuildStatus.event(e); } catch { /* never break the build */ }
            try {
                if (typeof AgentUI !== 'undefined' && AgentUI.onBuildProgress) AgentUI.onBuildProgress(convId, kind, e);
            } catch { /* progress display must never break the build */ }
        };

        // kind === 'artifact'
        if (typeof MakerService === 'undefined') return { error: 'Maker is not available in this build of Anjadhe.' };
        const status = await window.electronArtifacts?.status?.();
        if (!status?.enabled) {
            return { error: 'Maker is not enabled. Ask the user to open the Maker app and enable it first.' };
        }
        if (artifactId) {
            const res = await window.electronArtifacts.list();
            if (!(res?.artifacts || []).some(a => a.id === artifactId)) {
                return { error: `No artifact with id "${artifactId}". Call list_creations for valid ids.` };
            }
        }
        const result = await MakerService.start({ prompt: text, artifactId, onEvent: emit });
        if (!result?.ok) return { error: result?.error || 'The build failed — the user saw the progress log. Do not retry; ask how to proceed.' };
        return {
            ok: true,
            artifactId: result.artifactId,
            note: 'Artifact saved. The user can view it in Maker or via "Open in Maker" on the progress card.'
        };
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

    /**
     * Resolve which connected email account to act on for a write operation.
     * - If `provided` is given and matches a profile account → use it
     * - If `provided` is given but unknown → return candidates so the agent can retry
     * - If omitted and the profile has exactly one account → use it
     * - If omitted and the profile has multiple → return candidates so the agent must pick
     * Returns either { account: <account> } or { error, candidates? }.
     */
    resolveEmailAccount(provided) {
        if (typeof EmailApp === 'undefined') return { error: 'Email app not loaded.' };
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
            else if (AppManager.currentApp === 'focus') FocusApp.render();
            return;
        }
        const appMap = {
            notes: () => { NotesApp.loadNotes(); NotesApp.render(); },
            journal: () => { JournalApp.loadEntries(); JournalApp.render(); },
            portfolio: () => { PortfolioApp.loadData(); PortfolioApp.render(); },
            wellness: () => { WellnessApp.loadData(); WellnessApp.render(); },
            email: () => { EmailApp.loadData(); EmailApp.render?.(); },
            calendar: () => { CalendarApp.loadData(); CalendarApp.render?.(); }
        };
        if (AppManager.currentApp === appName && appMap[appName]) {
            appMap[appName]();
        }
    },

    mdToNoteHtml(md) {
        if (!md) return '';
        if (typeof AgentUI !== 'undefined' && typeof AgentUI.formatContent === 'function') {
            return AgentUI.formatContent(md);
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
            console.log(`[agent] think: ${text.slice(0, 200)}${text.length > 200 ? '…' : ''}`);
            return { ok: true };
        },

        /**
         * The in-app user guide (HelpDocs, help-docs.js). Unknown or missing
         * topic returns the index instead of an error — cheaper for a small
         * model to recover from than a retry loop.
         */
        get_help({ topic } = {}) {
            if (typeof HelpDocs === 'undefined') return { error: 'Help docs unavailable' };
            const doc = topic ? HelpDocs.get(String(topic)) : null;
            if (doc) return doc;
            return { topics: HelpDocs.index(), note: topic ? `Unknown topic "${topic}" — pick one of these.` : 'Pick the closest topic and call get_help again.' };
        },

        // ── READ ──

        list_focus() {
            const focusData = StorageManager.get('focus');
            const focusItems = (focusData?.focusItems || []).filter(f => f.parentId === null);
            const today = new Date().toISOString().split('T')[0];

            const result = focusItems.map(focus => {
                const goals = LinkManager.getGoalsForFocus(focus.id);
                const goalsWithTasks = goals.filter(g => g.status !== 'completed').map(g => {
                    const tasks = LinkManager.getTasksForGoal(g.itemId);
                    return {
                        id: g.itemId,
                        title: g.title,
                        status: g.status || 'not-started',
                        // Done = completed today for repeating tasks, ever for
                        // one-time (tasks have lastCompletedDate, not a flag).
                        // Compare against the LOCAL date — that's what
                        // lastCompletedDate is written with (getLocalToday).
                        tasks: tasks.filter(t => {
                            const d = new Date();
                            const localToday = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
                            // Abandoned counts as done — resolved either way.
                            const done = (t.repeat && t.repeat !== 'none')
                                ? (t.lastCompletedDate === localToday || isAbandonedOnDate(t, localToday))
                                : (!!t.lastCompletedDate || isOneTimeAbandoned(t));
                            return !done;
                        }).map(t => ({
                            id: t.itemId, title: t.title, startTime: formatTime12h(t.startTime),
                            scheduledDate: t.scheduledDate || null, repeat: t.repeat
                        }))
                    };
                });
                return {
                    id: focus.id,
                    title: focus.title,
                    description: focus.description || '',
                    goals: goalsWithTasks
                };
            });

            return { today, focusAreas: result };
        },

        list_goals(args) {
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
            if (args.status) {
                goals = goals.filter(g => g.status === args.status);
            }

            return {
                goals: goals.map(g => {
                    const focusArea = LinkManager.getFocusForItem('goals', g.id);
                    return {
                        id: g.id, title: g.title, targetDate: g.targetDate || null, status: g.status,
                        focusArea: focusArea ? focusArea.title : null
                    };
                })
            };
        },

        list_schedule(args) {
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

            return {
                filter: filterLabel, search: args.search || undefined,
                date: targetDate || today, currentTime: now,
                itemCount: items.length,
                items: items.map(i => {
                    const focusArea = LinkManager.getFocusForItem('schedule', i.id);
                    return {
                        id: i.id, title: i.title,
                        start: formatTime12h(i.startTime), end: formatTime12h(i.endTime),
                        repeat: i.repeat && i.repeat !== 'none' ? i.repeat : undefined,
                        focusArea: focusArea ? focusArea.title : undefined
                    };
                })
            };
        },

        list_notes(args) {
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
            // notes of full content would swamp the context window.
            return { notes: notes.slice(0, 20).map(n => ({
                id: n.id, title: n.title, tags: n.tags, pinned: n.pinned,
                snippet: AgentTools._noteText(n).slice(0, 120),
            })) };
        },

        // Notes are the one personal-data app whose content the agent could
        // match on but never read back, which left it asking the user to paste
        // in text the app was already holding. Shape mirrors fs_read.
        get_note(args) {
            const data = StorageManager.get('notes');
            const notes = data?.notes || [];
            const note = notes.find(n => n.id === args.id || String(n.id) === String(args.id));
            if (!note) return { error: `No note with id ${args.id}. Call list_notes or search_all to get valid ids.` };

            const text = AgentTools._noteText(note);
            const start = Math.max(0, parseInt(args.offset, 10) || 0);
            const slice = text.slice(start, start + AgentTools.NOTE_READ_CAP);
            return {
                id: note.id,
                title: note.title,
                tags: note.tags,
                pinned: note.pinned,
                content: slice,
                offset: start,
                totalChars: text.length,
                truncated: start + slice.length < text.length,
            };
        },

        list_journal(args) {
            const data = StorageManager.get('journal');
            let entries = data?.entries || [];

            if (args.date_from) {
                entries = entries.filter(e => e.date >= args.date_from);
            }
            if (args.date_to) {
                entries = entries.filter(e => e.date <= args.date_to);
            }

            return { entries: entries.slice(0, 20).map(e => ({ id: e.id, date: e.date, title: e.title, mood: e.mood, content: e.content?.substring(0, 200) })) };
        },

        list_portfolio(args = {}) {
            if (typeof PortfolioApp === 'undefined') return { error: 'Portfolio app not loaded.' };
            PortfolioApp.loadData();

            const full = args.include === 'full';
            const accounts = PortfolioApp.getAccounts();
            const properties = PortfolioApp.getProperties();
            const allHoldings = PortfolioApp.computeHoldings();

            // Rounding helpers — aggressive trimming shaves ~10-20% off the
            // token count vs raw floats. Prices keep 2dp only below $100; gains
            // and dollar values round to integer; percentages keep 1dp.
            const d0 = n => Math.round(n || 0);
            const d1 = n => Math.round((n || 0) * 10) / 10;
            const price = p => !p ? null : (p >= 100 ? Math.round(p) : Math.round(p * 100) / 100);

            const totalCash = accounts.reduce((s, a) => s + (a.cashBalance || 0), 0);
            const totalEquities = allHoldings.reduce((s, h) => s + h.currentValue, 0);
            const totalProperties = properties.reduce((s, p) => s + (p.currentValue || 0), 0);
            const netWorth = totalCash + totalEquities + totalProperties;
            const dayChange = allHoldings.reduce((s, h) => s + h.dayChange, 0);
            const equitiesPrior = totalEquities - dayChange;
            const dayChangePct = equitiesPrior > 0 ? (dayChange / equitiesPrior) * 100 : 0;

            const byClass = netWorth > 0 ? {
                cash: d1((totalCash / netWorth) * 100),
                equities: d1((totalEquities / netWorth) * 100),
                properties: d1((totalProperties / netWorth) * 100)
            } : { cash: 0, equities: 0, properties: 0 };

            const topHoldings = allHoldings.slice(0, 5).map(h => {
                const t = { ticker: h.ticker, value: d0(h.currentValue), pct: netWorth > 0 ? d1((h.currentValue / netWorth) * 100) : 0 };
                // Options: OCC symbols are unreadable — carry the label too.
                if (h.option) t.desc = PortfolioApp.displayTicker(h.ticker);
                return t;
            });

            const timestamps = Object.values(PortfolioApp.priceCache || {})
                .map(c => c?.updatedAt).filter(Boolean);
            const pricesAsOf = timestamps.length
                ? new Date(Math.max(...timestamps)).toISOString()
                : null;

            const result = {
                totals: {
                    cash: d0(totalCash),
                    equities: d0(totalEquities),
                    properties: d0(totalProperties),
                    netWorth: d0(netWorth),
                    dayChange: d0(dayChange),
                    dayChangePct: d1(dayChangePct)
                },
                allocation: { byClass, topHoldings },
                pricesAsOf
            };

            if (full) {
                result.accounts = PortfolioApp.computeHoldingsByAccount().map(({ account, holdings, cash }) => ({
                    name: account.name,
                    type: account.type,
                    cash: d0(cash),
                    holdings: holdings.map(h => {
                        // Skip zero fields to keep payload lean.
                        const out = { ticker: h.ticker, shares: h.totalShares };
                        // shares = contracts for options; value math already
                        // includes the 100× multiplier.
                        if (h.option) out.desc = PortfolioApp.displayTicker(h.ticker);
                        if (h.currentPrice) {
                            out.price = price(h.currentPrice);
                            out.value = d0(h.currentValue);
                            out.gain = d0(h.profitLoss);
                            out.gainPct = d1(h.profitLossPercent);
                        }
                        if (h.avgCostBasis) out.avgCost = price(h.avgCostBasis);
                        if (h.dayChangePercent) out.dayPct = d1(h.dayChangePercent);
                        return out;
                    })
                }));
                result.properties = properties.map(p => ({ name: p.name, value: d0(p.currentValue || 0) }));
            } else {
                result.accountCount = accounts.length;
                result.propertyCount = properties.length;
            }

            // The saved strategy rides along with the numbers — a plan the
            // model has to make a second call to discover is a plan it will
            // often skip. Status only; check_strategy does the scoring.
            if (typeof PortfolioStrategy !== 'undefined') {
                const active = PortfolioStrategy.getDefault();
                if (active) {
                    result.strategy = {
                        name: active.name,
                        status: active.status || 'active',
                        objective: active.objective || undefined,
                        hint: (active.status === 'draft')
                            ? 'Unfinished — start_strategy_interview resumes it.'
                            : 'Call check_strategy to score these holdings against it.'
                    };
                }
            }

            // Notes the user linked to the portfolio or its accounts —
            // separate from the saved strategy above, and often the reading
            // and research behind it.
            const linkedNotes = AgentTools._portfolioStrategyNotes(accounts);
            if (linkedNotes) result.linkedNotes = linkedNotes;

            return result;
        },

        get_ticker_detail(args) {
            if (typeof PortfolioApp === 'undefined') return { error: 'Portfolio app not loaded.' };
            if (!args?.ticker) return { error: 'ticker required' };
            PortfolioApp.loadData();

            const ticker = String(args.ticker).toUpperCase();
            const rollup = PortfolioApp.computeHoldings().find(h => h.ticker.toUpperCase() === ticker);
            if (!rollup) return { error: `No holding found for ${ticker}.` };

            const d0 = n => Math.round(n || 0);
            const d1 = n => Math.round((n || 0) * 10) / 10;
            const price = p => !p ? null : (p >= 100 ? Math.round(p) : Math.round(p * 100) / 100);

            const byAccount = PortfolioApp.getAccounts()
                .map(a => {
                    const h = PortfolioApp.computeHoldings(a.id).find(x => x.ticker.toUpperCase() === ticker);
                    return h ? { name: a.name, shares: h.totalShares } : null;
                })
                .filter(Boolean);

            const cached = PortfolioApp.priceCache?.[rollup.ticker];
            const out = {
                ticker: rollup.ticker,
                shares: rollup.totalShares,
                avgCost: price(rollup.avgCostBasis),
                byAccount,
                asOf: cached?.updatedAt ? new Date(cached.updatedAt).toISOString() : null
            };
            if (rollup.option) {
                // shares = contracts; avgCost/price are per-share premium and
                // value/gain already include the 100× contract multiplier.
                out.desc = PortfolioApp.displayTicker(rollup.ticker);
                out.option = { ...rollup.option, contractMultiplier: 100 };
            }
            if (rollup.currentPrice) {
                out.price = price(rollup.currentPrice);
                out.value = d0(rollup.currentValue);
                out.gain = d0(rollup.profitLoss);
                out.gainPct = d1(rollup.profitLossPercent);
            }
            if (rollup.dayChangePercent) out.dayPct = d1(rollup.dayChangePercent);
            return out;
        },

        async web_search(args) {
            if (!args?.query || !String(args.query).trim()) return { error: 'query required' };
            if (typeof window.electronSearch?.query !== 'function') {
                return { error: 'Web search not available in this build.' };
            }
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

        async refresh_portfolio_prices() {
            if (typeof PortfolioApp === 'undefined') return { error: 'Portfolio app not loaded.' };
            PortfolioApp.loadData();
            const tickers = PortfolioApp.getUniqueTickers();
            if (tickers.length === 0) return { refreshed: false, tickerCount: 0, message: 'No holdings to refresh.' };
            try {
                await PortfolioApp.refreshPrices();
                const timestamps = Object.values(PortfolioApp.priceCache || {})
                    .map(c => c?.updatedAt).filter(Boolean);
                return {
                    refreshed: true,
                    tickerCount: tickers.length,
                    pricesAsOf: timestamps.length ? new Date(Math.max(...timestamps)).toISOString() : null
                };
            } catch (e) {
                return { error: e.message || 'Failed to refresh prices' };
            }
        },


        // ── Wellness (health log) — backed by WellnessApp's registry so the
        // assistant and the UI share one definition of every metric. ──

        log_wellness(args) {
            if (typeof WellnessApp === 'undefined') return { error: 'Wellness app unavailable' };
            const kind = args.kind;
            const spec = WellnessApp.KINDS[kind];
            if (!spec) return { error: `Unknown kind "${kind}". Kinds: ${Object.keys(WellnessApp.KINDS).join(', ')}` };
            WellnessApp.loadData();

            // Normalize time: accept "YYYY-MM-DD HH:MM", ISO, or bare date.
            let time = typeof args.time === 'string' ? args.time.trim().replace(' ', 'T') : '';
            if (/^\d{4}-\d{2}-\d{2}$/.test(time)) time += spec.dateOnly ? 'T07:00' : 'T12:00';
            time = time.slice(0, 16);
            if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(time)) time = WellnessApp.nowLocal();
            if (spec.dateOnly) time = time.slice(0, 10) + 'T07:00';

            const values = { time };
            for (const f of spec.fields) {
                let v = args[f.id];
                if (v == null || v === '') continue;
                if (f.type === 'number' || f.type === 'segment') {
                    v = Number(v);
                    if (isNaN(v)) continue;
                    if (f.type === 'segment') v = Math.min(5, Math.max(1, Math.round(v)));
                } else {
                    v = String(v);
                }
                values[f.id] = v;
                if (f.unitKey) values.unit = WellnessApp.unitFor(f.unitKey);
            }
            for (const f of spec.fields) {
                if (f.required && (values[f.id] == null || values[f.id] === '')) {
                    return { error: `"${f.id}" is required for kind "${kind}"` };
                }
            }

            const entry = WellnessApp.addEntry(kind, values);
            AgentTools.refreshApp('wellness');
            const result = { success: true, entry };
            if (kind === 'bp') {
                result.category = WellnessApp.categorizeBp(Number(entry.systolic), Number(entry.diastolic)).label;
            }
            return result;
        },

        list_wellness(args = {}) {
            if (typeof WellnessApp === 'undefined') return { error: 'Wellness app unavailable' };
            WellnessApp.loadData();
            let entries = WellnessApp.sorted(args.kind && WellnessApp.KINDS[args.kind] ? args.kind : null);
            if (args.date_from) entries = entries.filter(e => e.time.slice(0, 10) >= args.date_from);
            if (args.date_to) entries = entries.filter(e => e.time.slice(0, 10) <= args.date_to);
            entries = entries.reverse().slice(0, Math.max(1, Math.min(100, args.limit || 20)));

            return {
                totalMatching: entries.length,
                units: WellnessApp.settings.units,
                entries: entries.map(e => {
                    const out = Object.assign({}, e);
                    if (e.kind === 'bp') {
                        out.category = WellnessApp.categorizeBp(Number(e.systolic), Number(e.diastolic)).label;
                    }
                    // Timing context makes bp/glucose numbers interpretable.
                    if (e.kind === 'bp' || e.kind === 'glucose') {
                        const ctx = WellnessApp.contextBefore(e.time);
                        out.lastMealBefore = ctx.lastMeal ? Object.assign({}, ctx.lastMeal, {
                            minutesBeforeReading: WellnessApp.minutesBetween(ctx.lastMeal.time, e.time)
                        }) : null;
                        out.lastActivityBefore = ctx.lastActivity ? Object.assign({}, ctx.lastActivity, {
                            minutesBeforeReading: WellnessApp.minutesBetween(ctx.lastActivity.time, e.time)
                        }) : null;
                    }
                    return out;
                })
            };
        },

        wellness_summary() {
            if (typeof WellnessApp === 'undefined') return { error: 'Wellness app unavailable' };
            WellnessApp.loadData();
            return Object.assign({ units: WellnessApp.settings.units }, WellnessApp.summary());
        },

        /**
         * Delegates to GlobalSearch, which also backs the ⌘K palette — one
         * search implementation rather than two that drift apart. The result
         * SHAPE is unchanged (flat records with the same per-app extra
         * fields); what improved is ranking. It used to return whatever the
         * scan found in registration order and cut at 20, which let a long
         * goals list starve notes entirely.
         */
        /**
         * The user's own news feed, not a web search.
         *
         * This exists so the Morning News background prompt reports on the
         * topics the user actually follows instead of whatever a generic
         * search turns up. The headlines are quoted from real sources with
         * real publication times (docs/DISCOVER.md gimmick-avoidance rule
         * #1: the model never authors a headline), so the model's job here
         * is summarising given text — the thing a 12B model does well —
         * rather than recalling world events, which it cannot.
         *
         * Awaits ensureFresh: a 7am digest reading a cache last filled at
         * 6pm yesterday would be worse than no digest.
         */
        async get_news(args) {
            if (typeof NewsFeed === 'undefined') return { error: 'News is not available' };

            const { interests } = NewsFeed.settings();
            if (!interests.length) {
                return { error: 'The user follows no news topics yet. They can pick some with the Topics button on the News page.' };
            }

            try {
                await NewsFeed.ensureFresh();
            } catch (e) {
                // Stale headlines beat none — fall through to whatever is cached.
                console.warn('[get_news] refresh failed:', e);
            }

            const cache = NewsFeed.cache();
            // visibleItems applies the user's "show fewer like this" hides,
            // so the assistant never reads back a story they dismissed.
            let items = NewsFeed.visibleItems(cache);

            const wanted = String(args.topic || '').trim().toLowerCase();
            if (wanted) items = items.filter(it => String(it.topic || '').toLowerCase() === wanted);

            const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 40);
            if (!items.length) {
                return {
                    topics: interests,
                    count: 0,
                    note: wanted
                        ? `No current headlines for "${args.topic}". Topics followed: ${interests.join(', ')}.`
                        : 'No current headlines cached. Web access may be off (Settings > AI Assistant > Web Search).'
                };
            }

            const ageMs = cache.generatedAt ? Date.now() - cache.generatedAt : null;
            return {
                topics: interests,
                updated: cache.generatedAt ? NewsFeed._ago(cache.generatedAt) : 'unknown',
                // An explicit flag, because "6h ago" in a field is easy for a
                // small model to skim past when it is about to write "today".
                stale: ageMs !== null && ageMs > 6 * 60 * 60 * 1000,
                // `count` is what the model can actually see. A bare total
                // would invite "here are your 20 stories" under a limit of 5.
                count: Math.min(items.length, limit),
                ...(items.length > limit ? { moreAvailable: items.length - limit } : {}),
                // No URLs: the digest names sources, and 20 links is a lot of
                // tokens for a local model to carry for no gain.
                items: items.slice(0, limit).map(it => ({
                    title: it.title,
                    source: it.source || '',
                    topic: it.topic || '',
                    published: it.publishedAt ? NewsFeed._ago(it.publishedAt) : 'undated'
                }))
            };
        },

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

            // Dedup: reuse existing goal but still attempt linking
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
                    targetDate: /^\d{4}-\d{2}-\d{2}$/.test(args.targetDate || '') ? args.targetDate : null,
                    status: args.status || 'not-started',
                    createdAt: now,
                    modifiedAt: now
                };
                goals.unshift(goal);
                StorageManager.set('goals', { goals });
                AgentTools.refreshApp('goals');
            }

            // Auto-link to focus area if provided
            let linkedFocus = null;
            let focusNotFound = null;
            if (args.focusTitle) {
                const focusItems = (StorageManager.get('focus') || {}).focusItems || [];
                const focus = AgentTools.findBySearchOrId(focusItems, args.focusTitle);
                if (focus) {
                    // Single-valued: replaces the goal's prior area, if any.
                    LinkManager.setFocusForItem('goals', goal.id, focus.id);
                    linkedFocus = focus.title;
                } else {
                    focusNotFound = `Focus area "${args.focusTitle}" not found. Create it first with create_focus, then use link_items.`;
                }
            }

            return { success: true, goal: { id: goal.id, title: goal.title, targetDate: goal.targetDate || null, status: goal.status }, linkedFocus, focusNotFound, alreadyExisted };
        },

        update_goal(args) {
            const data = StorageManager.get('goals') || {};
            const goals = data.goals || [];
            const goal = AgentTools.findBySearchOrId(goals, args.search, args.id);
            if (!goal) return { error: `Goal not found matching "${args.search || args.id}"` };

            if (args.new_title !== undefined) goal.title = args.new_title;
            if (args.status !== undefined) goal.status = args.status;
            if (args.targetDate !== undefined) {
                goal.targetDate = /^\d{4}-\d{2}-\d{2}$/.test(args.targetDate) ? args.targetDate : null;
            }
            // Completion is a status value now; `completed` stays as tool-level
            // shorthand (an explicit status wins if both are passed).
            if (args.completed !== undefined && args.status === undefined) {
                goal.status = args.completed ? 'completed' : 'in-progress';
            }
            delete goal.completed;
            goal.modifiedAt = new Date().toISOString();

            StorageManager.set('goals', { goals });
            AgentTools.refreshApp('goals');

            return { success: true, goal: { id: goal.id, title: goal.title, targetDate: goal.targetDate || null, status: goal.status } };
        },

        create_schedule_item(args) {
            const data = StorageManager.get('schedule') || {};
            const items = data.scheduleItems || [];

            // Dedup: reuse existing item but still attempt linking
            let item;
            let alreadyExisted = false;
            const existing = items.find(i => i.title?.toLowerCase() === args.title.toLowerCase());
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

        create_note(args) {
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

        create_journal_entry(args) {
            const data = StorageManager.get('journal') || {};
            const entries = data.entries || [];
            const now = new Date();
            const date = args.date || now.toISOString().split('T')[0];

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
            AgentTools.refreshApp('journal');

            return { success: true, entry: { id: newEntry.id, date: newEntry.date, mood: newEntry.mood } };
        },

        add_transaction(args) {
            const data = StorageManager.get('portfolio') || {};
            const accounts = data.accounts || [];
            const transactions = data.transactions || [];
            const now = new Date();

            // Find account by name (case-insensitive)
            let account = accounts.find(a => a.name.toLowerCase() === args.accountName.toLowerCase());

            // Create account if not found
            if (!account) {
                account = {
                    id: crypto.randomUUID(),
                    name: args.accountName,
                    type: 'brokerage',
                    cashBalance: 0,
                    createdAt: now.toISOString()
                };
                accounts.push(account);
            }

            const newTxn = {
                id: crypto.randomUUID(),
                accountId: account.id,
                type: args.type,
                ticker: args.ticker.toUpperCase(),
                quantity: args.quantity,
                pricePerShare: args.pricePerShare,
                date: args.date || now.toISOString().split('T')[0],
                notes: args.notes || '',
                createdAt: now.toISOString()
            };

            transactions.push(newTxn);
            StorageManager.set('portfolio', { ...data, accounts, transactions });
            AgentTools.refreshApp('portfolio');

            const out = {
                success: true,
                transaction: { id: newTxn.id, ticker: newTxn.ticker, type: newTxn.type, quantity: newTxn.quantity, pricePerShare: newTxn.pricePerShare },
                account: { id: account.id, name: account.name }
            };

            // If the trade puts the portfolio off plan, say so HERE — the
            // conflict belongs in the conversation that made the trade, not
            // in a drift table the user reads next month. Advisory only: the
            // transaction is already saved and stays saved.
            try {
                const conflict = PortfolioStrategy.checkTransaction({
                    accountId: account.id, ticker: newTxn.ticker, type: newTxn.type
                });
                if (conflict) {
                    out.strategyConflict = {
                        strategy: conflict.strategyName,
                        notes: conflict.notes,
                        hint: 'Tell the user this plainly after confirming the trade. Do not undo it or lecture — state the conflict, and ask whether they want to look at it.'
                    };
                }
            } catch (e) { /* an advisory never breaks the write */ }

            return out;
        },

        // ── STRATEGY ──
        //
        // The engine (PortfolioStrategy) owns the arithmetic and the agenda;
        // these handlers only marshal it in and out of the model. Nothing
        // here scores adherence or decides what to ask — that would put a
        // judgment call in the model's hands that the app can make exactly.

        get_strategy(args = {}) {
            const summarize = (s) => ({
                name: s.name,
                status: s.status || 'active',
                isOverall: !!s.isDefault,
                objective: s.objective || null,
                accounts: PortfolioStrategy.accountsUsing(s.id).map(a => a.name),
                updatedAt: s.updatedAt
            });

            if (!args.name) {
                const all = PortfolioStrategy.all();
                if (!all.length) {
                    return {
                        strategies: [],
                        hint: 'No strategy saved yet. If the user wants one, call start_strategy_interview.'
                    };
                }
                return { strategies: all.map(summarize) };
            }

            const strategy = PortfolioStrategy.find(args.name);
            if (!strategy) {
                return { error: `No strategy matching "${args.name}".`, available: PortfolioStrategy.all().map(s => s.name) };
            }
            return {
                ...summarize(strategy),
                horizon: strategy.horizon || null,
                riskLevel: strategy.riskLevel || null,
                thesis: strategy.thesis || null,
                coverage: strategy.coverage || null,
                reviewCadence: strategy.reviewCadence || null,
                targets: (strategy.targets || []).map(t => ({
                    label: t.label, tickers: t.tickers, includeCash: t.includeCash || undefined,
                    targetPct: t.targetPct, minPct: t.minPct, maxPct: t.maxPct
                })),
                rules: (strategy.rules || []).map(r => ({
                    kind: r.kind, value: r.value, tickers: r.tickers, text: r.text || undefined
                })),
                missing: PortfolioStrategy.missingTopics(strategy),
                recentChanges: (strategy.history || []).slice(0, 5)
            };
        },

        check_strategy(args = {}) {
            const strategy = args.name
                ? PortfolioStrategy.find(args.name)
                : PortfolioStrategy.getDefault();
            if (!strategy) {
                return {
                    error: args.name ? `No strategy matching "${args.name}".` : 'No strategy saved yet.',
                    hint: 'If the user wants one, call start_strategy_interview.'
                };
            }

            let accountId = null;
            if (args.accountName) {
                const account = (PortfolioApp.getAccounts() || [])
                    .find(a => a.name.toLowerCase() === String(args.accountName).toLowerCase())
                    || (PortfolioApp.getAccounts() || [])
                        .find(a => a.name.toLowerCase().includes(String(args.accountName).toLowerCase()));
                if (!account) return { error: `Account "${args.accountName}" not found.` };
                accountId = account.id;
            }

            if (PortfolioStrategy.missingTopics(strategy).length) {
                return {
                    strategy: strategy.name,
                    status: 'draft',
                    missing: PortfolioStrategy.missingTopics(strategy),
                    note: 'This strategy is unfinished, so there is nothing firm to measure against. Offer to finish it with start_strategy_interview.'
                };
            }

            const report = PortfolioStrategy.evaluate(strategy, { accountId });
            if (!report || report.empty) {
                return { strategy: strategy.name, status: 'no-data', note: 'Nothing held in scope yet.' };
            }

            // Rounded on the way out: two decimals of drift is noise the model
            // would otherwise repeat back verbatim.
            const r2 = (n) => Math.round(n * 10) / 10;
            return {
                strategy: strategy.name,
                scope: args.accountName || 'whole portfolio',
                status: report.status,
                headline: report.headline,
                targets: report.targets.map(t => ({
                    sleeve: t.label,
                    targetPct: t.targetPct,
                    band: `${t.minPct}-${t.maxPct}`,
                    actualPct: r2(t.actualPct),
                    status: t.status,
                    adjustment: Math.abs(t.deltaValue) < 1 ? 'none'
                        : `${t.deltaValue > 0 ? 'add' : 'trim'} $${Math.round(Math.abs(t.deltaValue)).toLocaleString('en-US')}`
                })),
                guardrails: report.rules.map(r => ({
                    rule: r.label, status: r.status, detail: r.detail,
                    ...(r.status === 'judgment' ? { note: 'Stated in words — you judge this one against the holdings.' } : {})
                })),
                notCoveredByPlan: report.unclassified
                    ? { pct: r2(report.unclassified.pct), tickers: report.unclassified.tickers, includesCash: report.unclassified.includesCash }
                    : null,
                unpricedHoldings: report.unpriced.length ? report.unpriced : undefined
            };
        },

        start_strategy_interview(args = {}) {
            const existing = args.name ? PortfolioStrategy.find(args.name) : null;
            const strategy = existing
                || PortfolioStrategy.all().find(s => (s.status || 'active') === 'draft')
                || null;

            const missing = PortfolioStrategy.missingTopics(strategy);
            const next = missing.length ? PortfolioStrategy.topic(missing[0]) : null;

            // Current holdings ride along so the allocation topic can be a
            // PROPOSAL grounded in what the user actually owns, rather than a
            // blank "what percentages do you want?" the user cannot answer.
            const holdings = (PortfolioApp.computeHoldings() || []).slice(0, 15);
            const total = holdings.reduce((s, h) => s + (h.currentValue || 0), 0)
                + (PortfolioApp.computeTotalCash() || 0);
            const context = {
                accounts: (PortfolioApp.getAccounts() || []).map(a => a.name),
                currentHoldings: total > 0 ? holdings.map(h => ({
                    ticker: PortfolioApp.displayTicker(h.ticker),
                    pctOfPortfolio: Math.round((h.currentValue / total) * 1000) / 10
                })) : [],
                cashPct: total > 0 ? Math.round((PortfolioApp.computeTotalCash() / total) * 1000) / 10 : null
            };

            return {
                instructions:
                    'Run this as an interview, not a form. Ask ONE topic at a time, in the order given, ' +
                    'and wait for the answer before moving on. For each: ask the question in your own words, ' +
                    'say in a sentence why it matters (use `why`), and offer the examples as a starting point ' +
                    'so the user has something to react to. After each answer, call save_strategy with just ' +
                    'that field, then ask the next question. save_strategy needs a name from the very first ' +
                    'call, so give it a short working title drawn from their first answer (e.g. "Retirement") ' +
                    'and settle the real name at the end, on the coverage topic. ' +
                    'Do not ask every topic at once, do not add topics ' +
                    'of your own, and never save a number the user did not agree to. For the allocation topic, ' +
                    'PROPOSE a mix based on their earlier answers and what they already hold (in `context`), ' +
                    'then let them correct it. When nothing is left, call check_strategy and show them how ' +
                    'their real holdings line up with what they just described.',
                strategy: strategy ? { name: strategy.name, status: strategy.status } : null,
                covered: strategy
                    ? PortfolioStrategy.INTERVIEW.filter(t => !missing.includes(t.id)).map(t => t.id)
                    : [],
                remaining: missing,
                nextTopic: next,
                agenda: PortfolioStrategy.INTERVIEW.map(t => ({
                    id: t.id, question: t.question, why: t.why,
                    examples: t.examples, hint: t.hint
                })),
                context
            };
        },

        save_strategy(args = {}) {
            if (!args.name || !String(args.name).trim()) {
                return { error: 'A strategy needs a name.' };
            }
            const saved = PortfolioStrategy.save(args);
            AgentTools.refreshApp('portfolio');

            const missing = PortfolioStrategy.missingTopics(saved);
            const next = missing.length ? PortfolioStrategy.topic(missing[0]) : null;
            return {
                success: true,
                strategy: saved.name,
                status: saved.status,
                isOverall: !!saved.isDefault,
                missing,
                nextTopic: next,
                hint: next
                    ? 'Ask the next question. Do not summarize the whole plan yet.'
                    : 'The strategy is complete. Call check_strategy now and show the user how their actual holdings line up with it.'
            };
        },

        assign_strategy(args = {}) {
            const accounts = PortfolioApp.getAccounts() || [];
            const account = accounts.find(a => a.name.toLowerCase() === String(args.accountName || '').toLowerCase())
                || accounts.find(a => a.name.toLowerCase().includes(String(args.accountName || '').toLowerCase()));
            if (!account) {
                return { error: `Account "${args.accountName}" not found.`, available: accounts.map(a => a.name) };
            }

            const wantsOverall = /^(overall|default|none|inherit)$/i.test(String(args.strategyName || '').trim());
            let strategy = null;
            if (!wantsOverall) {
                strategy = PortfolioStrategy.find(args.strategyName);
                if (!strategy) {
                    return { error: `No strategy matching "${args.strategyName}".`, available: PortfolioStrategy.all().map(s => s.name) };
                }
            }

            PortfolioStrategy.assignAccount(account.id, strategy ? strategy.id : null);
            AgentTools.refreshApp('portfolio');

            const applied = PortfolioStrategy.forAccount(account.id);
            return {
                success: true,
                account: account.name,
                follows: applied.strategy ? applied.strategy.name : null,
                inherited: applied.inherited
            };
        },

        update_cash(args) {
            const data = StorageManager.get('portfolio') || {};
            const accounts = data.accounts || [];

            const account = accounts.find(a => a.name.toLowerCase() === args.accountName.toLowerCase());
            if (!account) return { error: `Account "${args.accountName}" not found` };

            const prev = account.cashBalance || 0;
            if (args.operation === 'deposit') {
                account.cashBalance = prev + args.amount;
            } else if (args.operation === 'withdraw') {
                account.cashBalance = prev - args.amount;
            } else if (args.operation === 'set') {
                account.cashBalance = args.amount;
            }

            StorageManager.set('portfolio', { ...data, accounts });
            AgentTools.refreshApp('portfolio');

            return { success: true, account: { name: account.name, cashBalance: account.cashBalance, previousBalance: prev } };
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
            if (typeof EmailApp === 'undefined') return { error: 'Email app not loaded.' };
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
            if (typeof EmailApp === 'undefined') return { error: 'Email app not loaded.' };
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
            if (typeof EmailApp === 'undefined') return { error: 'Email app not loaded.' };
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

        async get_email(args) {
            if (typeof EmailApp === 'undefined') return { error: 'Email app not loaded.' };
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

            // Strip the body to plain text — agents don't need HTML and it bloats context
            const body = email.bodyText
                || (email.bodyHtml || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
                || email.snippet || '';

            return {
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
                ...(body ? {} : {
                    note: 'No body is stored locally for this message (only headers/snippet synced). Tell the user to open it in the Email app; do not try to reach Gmail another way.'
                })
            };
        },

        list_email_analyses(args) {
            if (typeof EmailApp === 'undefined') return { error: 'Email app not loaded.' };
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
            if (typeof EmailApp === 'undefined') return { error: 'Email app not loaded.' };
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
            if (typeof EmailApp === 'undefined') return { error: 'Email app not loaded.' };
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
            if (typeof EmailApp === 'undefined') return { error: 'Email app not loaded.' };
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
            if (typeof EmailApp === 'undefined') return { error: 'Email app not loaded.' };
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
            if (typeof EmailApp === 'undefined') return { error: 'Email app not loaded.' };
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

            console.log('[agent] create_calendar_event request', { account, eventData });
            const result = await window.electronCalendar.createEvent(account, 'primary', eventData);
            console.log('[agent] create_calendar_event result', result);

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

            console.log('[agent] update_calendar_event request', { account: event.account, eventId: event.id, eventData });
            const result = await window.electronCalendar.updateEvent(
                event.account,
                event.calendarId || 'primary',
                event.id,
                eventData
            );
            console.log('[agent] update_calendar_event result', result);
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

        create_focus(args) {
            const data = StorageManager.get('focus') || {};
            const focusItems = data.focusItems || [];
            const now = new Date().toISOString();

            const newFocus = {
                id: UIUtils.generateId(),
                title: args.title,
                description: args.description || '',
                parentId: null,
                createdAt: now,
                modifiedAt: now
            };

            focusItems.push(newFocus);
            StorageManager.set('focus', { focusItems });

            // Link existing goals if specified
            let linked = 0;
            if (args.goalTitles && args.goalTitles.length > 0) {
                const goalsData = StorageManager.get('goals') || {};
                const goals = goalsData.goals || [];
                for (const goalTitle of args.goalTitles) {
                    const goal = AgentTools.findBySearchOrId(goals, goalTitle);
                    if (goal) {
                        try {
                            LinkManager.addLink('focus', newFocus.id, 'goals', goal.id);
                            linked++;
                        } catch {}
                    }
                }
            }

            AgentTools.refreshApp('focus');
            return { success: true, focus: { id: newFocus.id, title: newFocus.title }, linkedGoals: linked };
        },

        link_items(args) {
            if (args.type === 'goal_to_focus') {
                const goals = (StorageManager.get('goals') || {}).goals || [];
                const focusItems = (StorageManager.get('focus') || {}).focusItems || [];
                const goal = AgentTools.findBySearchOrId(goals, args.itemSearch);
                if (!goal) return { error: `Goal not found matching "${args.itemSearch}"` };
                const focus = AgentTools.findBySearchOrId(focusItems, args.targetSearch);
                if (!focus) return { error: `Focus area not found matching "${args.targetSearch}"` };

                // Focus is single-valued on a goal — this replaces any prior area.
                LinkManager.setFocusForItem('goals', goal.id, focus.id);
                return { success: true, linked: { goal: goal.title, focusArea: focus.title } };
            } else if (args.type === 'task_to_goal') {
                const items = (StorageManager.get('schedule') || {}).scheduleItems || [];
                const goals = (StorageManager.get('goals') || {}).goals || [];
                const task = AgentTools.findBySearchOrId(items, args.itemSearch);
                if (!task) return { error: `Task not found matching "${args.itemSearch}"` };
                const goal = AgentTools.findBySearchOrId(goals, args.targetSearch);
                if (!goal) return { error: `Goal not found matching "${args.targetSearch}"` };

                LinkManager.addLink('goals', goal.id, 'schedule', task.id);
                return { success: true, linked: { task: task.title, goal: goal.title } };
            }
            return { error: `Unknown link type: ${args.type}` };
        },

        create_bookmark(args) {
            const data = StorageManager.get('bookmarks') || {};
            const bookmarks = data.bookmarks || [];
            const now = new Date().toISOString();

            const newBookmark = {
                id: UIUtils.generateId(),
                url: args.url,
                title: args.title || args.url,
                description: args.description || '',
                group: args.group || 'Uncategorized',
                favicon: '',
                createdAt: now
            };

            bookmarks.unshift(newBookmark);
            StorageManager.set('bookmarks', { ...data, bookmarks });
            AgentTools.refreshApp('bookmarks');

            return { success: true, bookmark: { id: newBookmark.id, title: newBookmark.title, url: newBookmark.url } };
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
                    focusArea: LinkManager.getFocusForItem('schedule', i.id)?.title || undefined
                })),
                completedCount: completedToday.length,
                overdue: overdue.slice(0, 10).map(i => ({ title: i.title, scheduledDate: i.scheduledDate })),
                activeGoals: activeGoals.map(g => ({
                    title: g.title, status: g.status, type: g.type,
                    focusArea: LinkManager.getFocusForItem('goals', g.id)?.title || undefined
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

            const existing = MemoryManager.findDuplicate({ type, title, body, profile: null });
            if (existing) {
                return { success: true, deduped: true, id: existing.id, title: existing.title };
            }

            try {
                const m = MemoryManager.create({ type, title, body, source: 'extracted' });
                return { success: true, id: m.id, title: m.title, type: m.type };
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
            return {
                count: hits.length + pages.length,
                memories: hits.map(m => ({ id: m.id, type: m.type, title: m.title, body: m.body })),
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

        // ── BACKGROUND PROMPTS (Prompt Feed) ──

        create_scheduled_prompt(args) {
            if (typeof NotePrompts === 'undefined') return { error: 'Background prompts are unavailable' };
            const body = (args.prompt || '').trim();
            if (!body) return { error: 'prompt is required' };
            const title = (args.title || '').trim();
            // Dedup by title against existing background prompts (active profile),
            // mirroring create_schedule_item's guard against re-creates.
            if (title) {
                let existing = NotePrompts.list().filter(n => NotePrompts.config(n).offline);
                const dup = existing.find(n => (n.title || '').trim().toLowerCase() === title.toLowerCase());
                if (dup) {
                    return { success: true, alreadyExisted: true, id: dup.id, title: dup.title,
                             schedule: NotePrompts.scheduleLabel(NotePrompts.config(dup)) };
                }
            }
            const note = NotePrompts.create({ title, body, config: {
                offline: true,
                interval: args.interval,
                time: args.time || null,
                web: !!args.web,
                useContext: !!args.useContext
            }});
            if (typeof PromptFeed !== 'undefined' && PromptFeed.onPromptsChanged) PromptFeed.onPromptsChanged();
            const cfg = NotePrompts.config(note);
            return {
                success: true, id: note.id, title: note.title,
                schedule: NotePrompts.scheduleLabel(cfg), web: cfg.web, useContext: cfg.useContext,
                note: 'First run starts within a couple of minutes; results appear in the Feed on the Home page.'
            };
        },

        list_scheduled_prompts() {
            if (typeof NotePrompts === 'undefined') return { error: 'Background prompts are unavailable' };
            let prompts = NotePrompts.list().filter(n => NotePrompts.config(n).offline);
            const runs = (typeof PromptFeed !== 'undefined' && PromptFeed.data && PromptFeed.data.runs) || {};
            return {
                count: prompts.length,
                prompts: prompts.map(n => {
                    const cfg = NotePrompts.config(n);
                    return {
                        id: n.id, title: n.title || 'Untitled prompt',
                        prompt: NotePrompts.bodyText(n),
                        interval: cfg.interval, time: cfg.time,
                        schedule: NotePrompts.scheduleLabel(cfg),
                        web: cfg.web, useContext: cfg.useContext,
                        lastRun: runs[n.id] || null
                    };
                })
            };
        },

        update_scheduled_prompt(args) {
            if (typeof NotePrompts === 'undefined') return { error: 'Background prompts are unavailable' };
            const id = (args.id || '').trim();
            if (!id) return { error: 'id is required' };
            if (!NotePrompts.list().some(n => n.id === id)) {
                return { error: 'Scheduled prompt not found — call list_scheduled_prompts for ids' };
            }
            const config = { offline: true };
            if (args.interval !== undefined) config.interval = args.interval;
            if (args.time !== undefined) config.time = args.time || null;
            if (args.web !== undefined) config.web = !!args.web;
            if (args.useContext !== undefined) config.useContext = !!args.useContext;
            const note = NotePrompts.update(id, {
                title: typeof args.title === 'string' ? args.title : undefined,
                body: typeof args.prompt === 'string' ? args.prompt : undefined,
                config
            });
            if (!note) return { error: 'Background prompt not found' };
            if (typeof PromptFeed !== 'undefined' && PromptFeed.onPromptsChanged) PromptFeed.onPromptsChanged();
            const cfg = NotePrompts.config(note);
            return { success: true, id: note.id, title: note.title,
                     schedule: NotePrompts.scheduleLabel(cfg), web: cfg.web, useContext: cfg.useContext };
        },

        delete_scheduled_prompt(args) {
            if (typeof NotePrompts === 'undefined') return { error: 'Background prompts are unavailable' };
            const id = (args.id || '').trim();
            if (!id) return { error: 'id is required' };
            const note = NotePrompts.list().find(n => n.id === id);
            if (!note) return { error: 'Scheduled prompt not found — call list_scheduled_prompts for ids' };
            NotePrompts.remove(id);
            return { success: true, deleted: { id: note.id, title: note.title || 'Untitled prompt' } };
        },

        // ── BUILD (Maker artifacts; user-built apps are read-only here) ──

        async list_creations() {
            const out = { apps: [], artifacts: [] };
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
            try {
                const res = await window.electronArtifacts?.list?.();
                out.artifacts = (res?.artifacts || []).map(a => ({
                    artifactId: a.id,
                    title: a.title || a.id,
                    kind: a.kind || undefined
                }));
            } catch { /* same */ }
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

            if (args.artifactId) {
                if (!window.electronArtifacts?.readFile) return { error: 'Maker is not available in this build of Anjadhe.' };
                const target = args.file || 'index.html';
                const rf = await window.electronArtifacts.readFile(args.artifactId, target);
                if (rf?.error) return { error: `Could not read ${target}: ${rf.error}` };
                if (rf?.content == null) return { error: `Artifact "${args.artifactId}" has no ${target}.` };
                const lf = await window.electronArtifacts.listFiles?.(args.artifactId);
                return {
                    kind: 'artifact',
                    artifactId: args.artifactId,
                    fileList: Array.isArray(lf?.files) ? lf.files : (Array.isArray(lf) ? lf : undefined),
                    files: { [target]: page(rf.content) }
                };
            }

            return { error: 'Pass appId or artifactId — call list_creations to find them.' };
        },

        create_artifact(args) {
            return AgentTools._runBuild('artifact', { prompt: args.prompt });
        },

        edit_artifact(args) {
            if (!args.artifactId) return { error: 'artifactId is required — call list_creations to find it' };
            return AgentTools._runBuild('artifact', { prompt: args.prompt, artifactId: args.artifactId });
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

        run_command(args) {
            if (!window.electronAgentFS?.run) return { error: 'Shell tool not available in this build.' };
            return window.electronAgentFS.run(args.command, args.cwd, args.timeoutSec);
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
        }
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

// Task mode (C4) ships behind its own flag the same way.
if (typeof FEATURES === 'undefined' || !FEATURES.isEnabled('taskmode')) {
    AgentTools.definitions = AgentTools.definitions.filter(d => d.function && d.function.name !== 'start_task');
    delete AgentTools.handlers.start_task;
}

