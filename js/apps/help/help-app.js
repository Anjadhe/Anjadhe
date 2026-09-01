/**
 * Help App — Settings-style master/detail.
 *
 * The root is a list of feature topics (same card rows as the Settings
 * root); clicking one opens a plain-English explainer for that feature.
 * Content lives in TOPICS below — static HTML strings, grouped the way the
 * launcher groups the apps. Keep the language simple: what it is, how to
 * use it, where things live. No marketing voice.
 */

const HelpApp = {
    _topic: null,   // open topic id, or null for the root list
    _query: '',     // current search text on the root list

    TOPICS: [
        // ── The framework ────────────────────────────────────────────
        {
            id: 'actions', group: 'Your day', title: 'Actions — Tasks & Today',
            blurb: 'The front door: what to do today, in one short list.',
            body: `
                <p>Actions has two tabs. <strong>Tasks</strong> is what to do now, and <strong>Email AI</strong> is everything the assistant found in your mail. Planning lives behind the <strong>Plan</strong> button on the Tasks page, which opens <strong>Projects</strong>. Tasks opens to <strong>Today</strong> — tasks due today, anything overdue, repeating tasks, action items pulled from email, and today's calendar events. When everything is checked off, it says so — "done for today" is a real, reachable state.</p>
                <h4 class="help-heading">Filter along two dimensions</h4>
                <p>The nav beside the list combines <strong>dates</strong> (Today, Tomorrow, This Week, This Month, Later, All time) with your <strong>project groups</strong>. Pick one of each — say Today + Health — and the list narrows to tasks linked to that group's projects. Pills above the list show the active filters; the &times; on a pill clears just that one. Every view ends with a collapsed "N done" section of completed tasks.</p>
                <h4 class="help-heading">Adding things quickly</h4>
                <p>Type into the "Add an action" box in plain language — <em>"Call dentist tomorrow 3pm"</em> becomes a task named "Call dentist", dated tomorrow, at 3:00 PM. Repeats work too: <em>"Water plants every tuesday"</em>, <em>"Pay rent monthly"</em>. Chips under the box show what was understood before you press Enter.</p>
                <h4 class="help-heading">Overdue</h4>
                <p>Overdue tasks show above today's list. "Push to today" on the section header moves them all to today in one click; hovering a single row shows "&rarr; Today" for just that one.</p>
                <h4 class="help-heading">On a task's page</h4>
                <p>Two honest buttons: <strong>Mark complete</strong> (did it) and <strong>Mark abandoned</strong> (deliberately not doing it) — both resolve the task everywhere. Repeating tasks show a history of past occurrences. Edits save themselves as you type — there's no Save button on an existing task. Back in the list, the &#8943; menu on a row (or a right-click) offers Open, Set date, Rename, and Delete.</p>
                <h4 class="help-heading">Weekly review</h4>
                <p>The quiet "Weekly review" link beside the Today pill walks you through a short guided review — what got done, what's stuck, what matters next week. It nudges you at most once a week.</p>`
        },
        {
            id: 'fyi', group: 'Your day', title: 'Email AI',
            blurb: 'Everything the assistant found in your email, grouped by kind.',
            body: `
                <p>Not everything worth knowing is something to do. A flight confirmation, a renewal date, a statement closing, a package arriving: none of those is a task, but you still want them somewhere you can find them. <strong>Email AI</strong> is that somewhere.</p>
                <p>It holds <em>everything</em> found in your mail. Anything that needs doing <em>also</em> becomes a task on the <strong>Tasks</strong> tab, with a badge linking back to the email &mdash; and the insight here links forward to that task. The two answer different questions: Tasks is what you have to do, this is what your mail said.</p>
                <h4 class="help-heading">One word per folder</h4>
                <p>The sidebar groups what was found by what actually happened, and each folder says what belongs in it under its title:</p>
                <ul class="help-app-list">
                    <li><strong>Bills</strong> &mdash; money you owe: invoices, statements, amounts due, charges coming up.</li>
                    <li><strong>Receipts</strong> &mdash; money already paid: purchases, payments that went through, refunds.</li>
                    <li><strong>Renewals</strong> &mdash; things you already have that renew or expire: subscriptions, memberships, insurance, licences.</li>
                    <li><strong>Appointments</strong> &mdash; times you need to be somewhere.</li>
                    <li><strong>Reservations</strong> &mdash; trips and bookings you hold: flights, hotels, cars, tables, tickets.</li>
                    <li><strong>Deliveries</strong> &mdash; orders on their way to you.</li>
                    <li><strong>Deadlines</strong> &mdash; dates something is due back or due in, like library books or a form to return.</li>
                    <li><strong>Security</strong> &mdash; sign-ins, passwords, and account alerts.</li>
                    <li><strong>Other</strong> &mdash; worth knowing, but none of the above.</li>
                </ul>
                <p>A folder only appears when there is something in it, so the page is never a wall of empty headings. Marketing never lands here: an offer to subscribe, upgrade or buy is not an insight, however much it talks about renewals, expiry or discounts.</p>
                <h4 class="help-heading">Reading something doesn&rsquo;t make it vanish</h4>
                <p>Items stay for 90 days whether or not you have looked at them, so the hotel you booked in June is still here the morning you travel. Unread ones carry a dot, and the <strong>Unread</strong> toggle narrows to just those when you want to catch up. Anything older stays findable through Inbox search and &#8984;K.</p>
                <h4 class="help-heading">The date column</h4>
                <p>The left column says when the thing happens: "in 3 days", "tomorrow", "Aug 12". Plenty of mail has no date of its own ("StreamNest charged $15.99"), and those rows show in italics when the mail arrived instead, so the two kinds of date never get confused.</p>
                <h4 class="help-heading">Reading one</h4>
                <p>Click any row and it opens in the pane on the right: the summary, then the facts pulled out of the mail (a flight&rsquo;s route and times, a booking code, an amount due), then the buttons to turn it into a task, mute the sender, or say it wasn&rsquo;t useful. <strong>Open email</strong> goes to the message it came from. Drag the divider between the list and the pane to set how much room each gets; the width is remembered on this Mac.</p>
                <p>To stop seeing a whole category, open Settings &rsaquo; Inbox and untick it there.</p>`
        },
        {
            id: 'goals', group: 'Your day', title: 'Projects',
            blurb: 'Come up with projects, break them into tasks, and plan.',
            body: `
                <p>A project is something you can finish: ship the release, run the marathon, hit the savings number. Each project has what "done" looks like, a target date, a <strong>group</strong> label, and a list of linked tasks. A project is either completed or it isn't — the progress lives in its tasks, and the n/m count on every project shows it.</p>
                <h4 class="help-heading">Set up a project by talking</h4>
                <p>The <em>"Help me plan a new project"</em> button opens the assistant, which walks you through it one question at a time — what you want to accomplish, what done looks like, by when — then proposes the first steps as tasks with dates for you to approve. Stop mid-conversation and the project is saved as a <strong>draft</strong> you can finish later. You can also add and edit projects by hand — every field on a project's page saves as you change it.</p>
                <h4 class="help-heading">Groups</h4>
                <p>Projects are shown grouped by a plain <strong>Group</strong> field — Work, Health, Family, whatever you type. There is nothing to manage: a group exists because a project carries its name. Reuse an existing name (the field suggests them), edit the field to move a project, or drag a project onto a group in the sidebar.</p>
                <h4 class="help-heading">Staying honest</h4>
                <p><strong>Review it weekly</strong> on a project's page schedules an AI review: each week it reads the project's linked tasks and posts a short honest read to your Home feed — moving, stalled, or done in all but name. Feeling stuck is a conversation, not a label: the <em>"I'm stuck"</em> button hands the project to the assistant. On the Actions Today page, tasks show their project as a small chip — click it to jump to the project.</p>`
        },
        {
            id: 'tasks', group: 'Your day', title: 'Tasks',
            blurb: 'Everything you’ve committed to, with dates, repeats, and reminders.',
            body: `
                <p>Tasks is the full inventory — every commitment, in Agenda view (grouped by day) or List view (grouped by status). Today's slice of it shows on the Actions page.</p>
                <h4 class="help-heading">Quick add speaks English</h4>
                <p><em>"Water plants every tuesday"</em>, <em>"Pay rent monthly"</em>, <em>"Review PRs weekdays 9am"</em> — dates, times, and repeat patterns are understood as you type, and the chips under the box show what was recognized before you press Enter.</p>
                <h4 class="help-heading">Repeating tasks</h4>
                <p>A repeating task comes back on its schedule: daily, weekdays, a weekly day, custom days, monthly, or annually. Checking it off completes it for <em>today</em>; tomorrow it returns.</p>
                <h4 class="help-heading">Complete vs. abandoned</h4>
                <p>The task page has two honest buttons: <strong>Mark complete</strong> (did it) and <strong>Mark abandoned</strong> (deliberately not doing it today). For repeating tasks, the History section below shows each past occurrence — completed, abandoned, or no record — so you can see how a routine is actually going.</p>
                <h4 class="help-heading">Also here</h4>
                <p>Reminders before the due time, a work timer per task (the Pomodoro button in the header runs focus sessions against a task), a search box, and filters by project.</p>`
        },

        // ── The assistant ────────────────────────────────────────────
        {
            id: 'assistant', group: 'The assistant', title: 'AI Assistant',
            blurb: 'A private assistant that knows your data and can act on it.',
            body: `
                <p>The assistant is one chat that can do three kinds of things:</p>
                <ul class="help-app-list">
                    <li><strong>Answer about your life</strong> — it reads your tasks, projects, notes, journal, email insights, and calendar, so "what's due this week?" or "summarize my journal this month" just work.</li>
                    <li><strong>Do things for you</strong> — create tasks and notes, file action items, search the web, read pages, and (if enabled in Settings &rsaquo; AI) work with files or browse websites.</li>
                    <li><strong>Answer anything</strong> — it's also a normal assistant for questions, advice, writing, and math.</li>
                </ul>
                <h4 class="help-heading">Private by design</h4>
                <p>The model runs on your Mac through the built-in llama.cpp engine, or on a server you own. There is no cloud AI option — your conversations and personal data only reach hardware you control. Pick and manage the model in Settings &rsaquo; AI (the gear icon in the assistant's header).</p>
                <h4 class="help-heading">Trust the sources</h4>
                <p>When an answer used the web, a <strong>Sources</strong> row appears under it listing what was searched and every page actually opened. It's recorded from what the assistant really did — not from what it claims.</p>
                <h4 class="help-heading">Memory</h4>
                <p>The assistant keeps durable notes about you (preferences, ongoing situations) and uses them in later chats. Click <strong>memory</strong> in the header to read or edit everything it remembers.</p>
                <h4 class="help-heading">Long jobs</h4>
                <p>Big requests can become a <em>task</em>: the assistant plans the steps, you approve, it works through them and reports back. If it hits its per-turn action limit, it writes up what it has so far and asks whether to continue.</p>`
        },
        {
            id: 'prompts', group: 'The assistant', title: 'Routines & the feed',
            blurb: 'Routines run on a schedule and post results to a feed.',
            body: `
                <p>A <strong>routine</strong> is a prompt that runs on a schedule (daily, weekly…) in the background on your local model — "summarize AI news every morning". Manage them on the <strong>Routines</strong> page (or <strong>Manage routines</strong> on the home feed). A prompt you run by hand instead is a <strong>saved prompt</strong>: it lives in the Notes app (a note template) with a panel to run it in the Assistant or browser — schedule it there and it becomes a routine.</p>
                <p>Routine runs post to the <strong>feed</strong> on your home page — each result shows when it ran and which model wrote it. Open a post to read it full-page; from there, <strong>Discuss with Assistant</strong> starts a chat that already has the result in context, so you can ask follow-ups immediately. Unread <strong>email insights</strong> (renewals, bills, appointments) appear in the same feed; the &times; on one marks it read.</p>
                <p>Anjadhe ships with a few starter routines — <strong>Daily Briefing</strong> (your tasks and calendar each morning), <strong>News Digest</strong>, <strong>Daily Motivation</strong>, and <strong>Weekly Reflection</strong>. Edit, reschedule, or delete them freely.</p>
                <p>Options per routine: use your personal context (run through the assistant with your briefing), allow web search, or plain offline generation.</p>`
        },
        {
            id: 'ai-activity', group: 'The assistant', title: 'AI Activity',
            blurb: 'See what the AI engine is doing on this Mac, and why.',
            body: `
                <p>AI Activity shows what is using the AI engine on this Mac — as plain activities, not logs. A status line says whether the engine is idle, working, or loading a model, and which model is held in memory. <strong>Happening now</strong> lists requests in flight with a live timer; <strong>Recent</strong> lists past activities with model, duration, and when they ran. Rows marked <em>automatic</em> are work the app started for you.</p>
                <h4 class="help-heading">Why is the GPU busy when I'm not chatting?</h4>
                <p>Anjadhe runs AI in the background on your behalf: email insights after a mail sync, routines, memory tidy-ups after a chat, and model warm-ups (loading the model so your first message answers fast). All of it shows here, so a busy GPU always has a visible reason. The pulse icon in the titlebar gets an amber dot whenever AI work is running — click it to land on this page.</p>
                <h4 class="help-heading">From activity to full detail</h4>
                <p>Click a row to open the exact request in the LLM logs (full prompt, response, and token counts). The activity list is per-Mac and doesn't sync; <strong>Clear</strong> empties it without touching the logs.</p>`
        },

        // ── Connected accounts ───────────────────────────────────────
        {
            id: 'email', group: 'Connected accounts', title: 'Inbox and Email AI',
            blurb: 'Gmail on this Mac: bundles, insights, and action items.',
            body: `
                <p>Connect Gmail (Settings &rsaquo; Accounts, or the gear in the Inbox header) and mail syncs from Google's servers straight to this Mac — no service in the middle.</p>
                <ul class="help-app-list">
                    <li><strong>Bundles</strong> — categorical mail (newsletters, promotions, receipts) is grouped so your inbox reads as a handful of piles, not a hundred rows.</li>
                    <li><strong>Insights</strong> — the AI reads important mail and writes short summaries of what matters.</li>
                    <li><strong>Action items</strong> — deadlines, renewals, RSVPs found in mail become tasks automatically, with a source badge linking back to the email. Confirm or dismiss; never retype.</li>
                    <li><strong>All of it</strong> is collected in <strong>Email AI</strong>, its own app beside the Inbox, grouped by kind: bookings, bills, deliveries, renewals &mdash; including the ones that became tasks.</li>
                </ul>
                <p>Each Mac syncs mail independently (Gmail is the source of truth), and analysis happens locally on your model.</p>`
        },
        {
            id: 'calendar', group: 'Connected accounts', title: 'Calendar',
            blurb: 'A timeline lens over your tasks plus Google Calendar events.',
            body: `
                <p>The Calendar shows your scheduled tasks and Google Calendar events on one timeline — month, week, or day. It's a <em>lens</em>: tasks live in Tasks, events live in Google; the calendar just lets you see time.</p>
                <p>Connect Google Calendar in Settings &rsaquo; Accounts. Today's events also appear at the bottom of the Actions Today page for time context.</p>`
        },

        // ── Apps ─────────────────────────────────────────────────────
        {
            id: 'notes', group: 'Apps', title: 'Notes',
            blurb: 'Rich-text notes with tags, templates, and AI-written notes.',
            body: `
                <p>Notes is a straightforward rich-text notebook: write, format, tag, pin, search. A few things worth knowing:</p>
                <ul class="help-app-list">
                    <li><strong>Templates</strong> — a note can be <em>Blank</em>, a <em>Book</em> (chapters with a table of contents), or a <em>Prompt</em> (see Routines).</li>
                    <li><strong>AI Assistant notes</strong> — when the assistant writes a note for you, it's typed "AI Assistant" with a &#10024; chip, and the sidebar gets a filter to see them all.</li>
                    <li><strong>Define</strong> — select a word in any note to look it up in place.</li>
                </ul>`
        },
        {
            id: 'journal', group: 'Apps', title: 'Journal',
            blurb: 'Dated entries with mood — list view or diary view.',
            body: `
                <p>The journal is for dated reflection: one or more entries per day, each with an optional mood. Read it as a list or flip through the diary view.</p>
                <p>The assistant can read your journal when you ask it to ("how was my week?") and can write entries for you ("journal this: …"). A gentle home-page nudge appears if you haven't written today.</p>`
        },
        {
            id: 'bookmarks', group: 'Apps', title: 'Bookmarks',
            blurb: 'Saved links with tags, grid or list.',
            body: `
                <p>Save links with a title and tags; browse them as a grid or a list. Clicking a bookmark opens the page in the built-in browser, with a "Back to Bookmarks" strip to return; the small <em>i</em> button on a card opens its details (description, tags, edit, delete). The assistant can save bookmarks for you and can pull them into research when you ask.</p>`
        },
        {
            id: 'wellness', group: 'Apps', title: 'Wellness',
            blurb: 'Track vitals, sleep, meals, water, workouts, and mood in one timeline.',
            body: `
                <p>Wellness is one place to log everything about your health: blood pressure and pulse, weight, blood glucose, SpO2, temperature, meals, water, activities with heart rate, sleep, mood, medications, and symptoms. The <strong>quick log box</strong> at the top takes plain language — <em>"BP 128/82 after my walk"</em>, <em>"strength training 45 min, bench 3x8, squats 3x10"</em> — and the assistant files it with every detail kept; the <strong>+ Log</strong> button has the precise forms.</p>
                <ul class="help-app-list">
                    <li><strong>Attention, computed</strong>: the page points out what the numbers actually show — an activity streak, blood pressure drifting against last month, a habit gone quiet. Pure arithmetic; when there is nothing to say, it says nothing.</li>
                    <li><strong>AI reviews</strong>: turn on a <strong>Wellness Review</strong> (Sunday mornings, an honest read of your week) or a <strong>Daily Check-in</strong> (a short morning note with one intention). Both post to your Home feed, use the computed trends, and can speak in one of your Writing Voices.</li>
                    <li><strong>Readings in context</strong>: each blood pressure or glucose entry shows how long after your last meal and activity it was taken, so a high number after a workout reads differently from a high fasting number.</li>
                    <li><strong>Trends</strong>: pick any metric (BP, weight, glucose, sleep, water, mood, steps) and a time range to see its chart. The BP chart marks the 120/80 reference lines.</li>
                    <li><strong>Units</strong>: switch lb/kg, mg/dL/mmol/L, F/C, and oz/ml from the Units button. Entries keep the unit they were logged in and convert for display.</li>
                    <li><strong>Ask the assistant</strong>: "how has my BP trended this month?", "any link between my sleep and my readings?". It reads the same data, locally.</li>
                </ul>
                <p>Wellness is a personal log, not a medical device; talk to your doctor about anything concerning.</p>`
        },
        {
            id: 'portfolio', group: 'Apps', title: 'Portfolio',
            blurb: 'Accounts, holdings, and live prices — all stored locally.',
            body: `
                <p>Track investment accounts (brokerage, 401k, IRA, HSA…), their holdings, and properties. Prices refresh from Yahoo Finance; cost basis uses the average-cost method; a value history chart shows the trend.</p>
                <p>Everything is stored locally like the rest of your data. The <strong>Show/Hide</strong> button in the header blanks all dollar values when someone's looking over your shoulder. Snapshot saves today's total to the history.</p>
                <p>Analysis lives with the assistant, not in the app: ask it about concentration, drift, or your strategy, and three weekday background reviews (pre-market, midday, market close) post to the Home feed. Edit or disable them in the Routines app.</p>`
        },
        {
            id: 'browse', group: 'Apps', title: 'Browse',
            blurb: 'A built-in browser with tracking protection and the assistant one click away.',
            body: `
                <p>Browse is a small built-in web browser: tabs, a combined search-and-address bar, history (Cmd+Y), and a home page. The + opens a new tab (Cmd+T); the crossed-eye button opens a <strong>private tab</strong> (Cmd+Shift+N) that leaves no history behind.</p>
                <ul class="help-app-list">
                    <li><strong>Tracking protection</strong> — the shield counts the trackers blocked on the page; click it for the list, or to switch protection off for one site.</li>
                    <li><strong>Reader mode</strong> — strips a page down to just its text.</li>
                    <li><strong>Bookmark &amp; reading list</strong> — the bookmark button saves the page into the Bookmarks app; the reading-list button saves it for later.</li>
                    <li><strong>Ask</strong> — Cmd+/ (or the Ask button) hands the current page to the AI Assistant so you can ask questions about it.</li>
                </ul>
                <p>When another app hands a link to Browse, a return strip at the top takes you back where you came from.</p>`
        },

        {
            id: 'news', group: 'Apps', title: 'News',
            blurb: 'A front page of current headlines for the topics you follow, read and summarized on your Mac.',
            body: `
                <p>News is a front page of current headlines for your topics: a lead story, a Latest rail, then a section per topic — "All N stories" drills into a topic. Headlines come straight from news feeds; no AI writes them. Stories you have already opened dim.</p>
                <ul class="help-app-list">
                    <li><strong>Topics</strong> — the Topics button opens the topics dialog. Pick from the suggestions or add your own; an optional location adds local news.</li>
                    <li><strong>Reader</strong> — clicking a headline fetches and summarizes the article on your Mac, with <strong>Open article</strong> for the original page and <strong>Ask about this</strong> to discuss it with the assistant. Dates the AI spots in an article can be added to Schedule with one click.</li>
                    <li><strong>Catch me up</strong> — writes a short AI digest of the current headlines, on your Mac. Needs an AI model set up.</li>
                    <li><strong>Show fewer like this</strong> — the &times; on any story teaches ranking; restore hidden stories from the Topics dialog. Boosted stories carry a "For you" label with the reason.</li>
                </ul>
                <p>News needs web search enabled (<strong>Settings → AI Assistant → Web Search</strong>). Headlines refresh when you open News. Clicks, hides, and ranking stay on this Mac.</p>`
        },

        {
            id: 'reader', group: 'Apps', title: 'Reader',
            blurb: 'Your documents, indexed on this Mac — read them with AI at hand.',
            body: `
                <p><strong>Reader</strong> holds documents you bring in — reports, essays, papers, statements — indexed on this Mac so you can search them by meaning and ask the assistant about them. You never create documents here; you read and ask.</p>
                <h4 class="help-heading">Getting documents in</h4>
                <p>Click <strong>Import files&hellip;</strong>, drag files onto the page, or drop them into the folder in Finder (<strong>Open folder</strong> shows it). Supported: <code>.md</code>, <code>.txt</code>, <code>.pdf</code> (scans included), <code>.docx</code>, <code>.html</code>. A folder becomes a collection; documents you give a Writing Voice appear here too, marked as that voice's.</p>
                <h4 class="help-heading">Search, then read</h4>
                <p>The search box finds passages across everything, grouped by document. Click one and the document opens right there — full text, your terms marked, scrolled to the match — with <strong>Open original</strong>, <strong>Show in Finder</strong>, and <strong>Ask about this document&hellip;</strong>, which opens the assistant already knowing what you're reading. Semantic (by-meaning) search needs a one-time ~330&nbsp;MB model download in <strong>Settings &rsaquo; Reader &amp; Writing Voices</strong>; until then it works by keywords.</p>
                <h4 class="help-heading">Private by default</h4>
                <p>Indexing always runs locally, whatever AI brain you chose for chat. Only the passages the assistant retrieves for a question travel with that chat turn. Deleting a document moves the file to the Trash — recoverable, never a hard delete.</p>`
        },
        {
            id: 'library', group: 'Apps', title: 'Writing Voices',
            blurb: 'Writing styles learned from documents — yours or anyone\u2019s — for drafts that sound right.',
            body: `
                <p>A <strong>writing voice</strong> is a way of writing, learned from documents: <em>My voice</em> from your own posts and essays, <em>Mark Twain</em> from his essays and speeches. The app opens on your voices; each holds its own documents, an editable description of how it writes, and real passages it imitates.</p>
                <h4 class="help-heading">Create one</h4>
                <p>Name it in the box at the top — or tap a <strong>sample voice</strong> (Mark Twain, Abraham Lincoln; built from public-domain works) to see the whole flow with documents included. It gets its own folder on this Mac, and everything else happens on its page: <strong>Add documents&hellip;</strong> (or drag files onto the page) to teach it, then <strong>Study</strong> — the assistant reads a sample and writes a short <em>style guide</em> (tone, rhythm, phrases, moves) plus passages that carry the voice. The guide is yours: edit it and your edits stick through re-studies; pin the best passages. Supported files: <code>.md</code>, <code>.txt</code>, <code>.pdf</code>, <code>.docx</code>, <code>.html</code>.</p>
                <h4 class="help-heading">Draft in it</h4>
                <p><strong>Draft in this voice&hellip;</strong> (on the voice's page, or the <strong>Draft&nbsp;&rarr;</strong> on its row) opens the assistant already primed — it greets you, you say what to write, and the draft names the documents it drew on. Asking any chat to write <em>"in X's voice"</em> works too.</p>
                <h4 class="help-heading">Routines can speak in a voice</h4>
                <p>A routine that writes you posts (a daily review, a weekly digest) can carry a voice: pick it on the routine's form under <strong>Voice</strong>, or ask the assistant to set one when creating the routine. The default is the assistant's own voice, and a routine keeps running in it if its voice is ever deleted.</p>
                <h4 class="help-heading">Search, then read</h4>
                <p>The search box finds passages across <em>all</em> your documents, grouped by document; click one and it opens right there — full text, terms marked, scrolled to the match — with <strong>Open original</strong> and <strong>Show in Finder</strong> for the file itself. Semantic (by-meaning) search needs a one-time ~330&nbsp;MB model download in <strong>Settings &rsaquo; Writing Voices</strong>; until then it works by keywords.</p>
                <h4 class="help-heading">Documents outside a voice</h4>
                <p>Files imported with the header's <strong>Import files&hellip;</strong> or dropped into the folder in Finder (<strong>Open folder</strong> shows it) appear under <strong>Other documents</strong> — searchable and readable, just not teaching any voice. Deleting a voice never deletes its documents. To delete a document, hover its row and click <strong>Remove</strong> (or <strong>Delete</strong> while reading it) — the file moves to the Trash, so you can always get it back.</p>
                <h4 class="help-heading">Private by default</h4>
                <p>Everything is indexed <em>on this Mac</em> by a small local model, whatever AI brain you use for chat. What travels with a chat turn is only the passages the assistant retrieves for that question — they go to the model you chose, and nowhere else.</p>
                <p>Writing Voices is <strong>off by default</strong> while it's new: turn it on in <strong>Settings &rsaquo; Developer &rsaquo; Experimental features</strong>, then reload.</p>`
        },
// ── The platform ─────────────────────────────────────────────
        {
            id: 'privacy', group: 'How it works', title: 'Privacy & your data',
            blurb: 'Everything stays on hardware you control. Where it lives.',
            body: `
                <p>Anjadhe is private by default. There is no remote database and no account. Your data is stored on this Mac at:</p>
                <div id="help-storage-path" class="help-path"></div>
                <p>AI runs on open-weight models — on this Mac through the built-in engine, or on a server you own. Your data and AI conversations only ever reach hardware you control.</p>
                <p>Backups and the storage location are managed in Settings &rsaquo; Data. Transparency logs of every AI call and web search are in Settings &rsaquo; AI &rsaquo; Logs — machine-local, never synced.</p>`
        },
        {
            id: 'sync', group: 'How it works', title: 'Sync between Macs',
            blurb: 'Your Macs stay in sync via iCloud Drive.',
            body: `
                <p>Changes travel between your Macs through your own iCloud Drive, encrypted. Merging happens when the app starts or you refresh (Cmd+R) — never mid-work — and the titlebar briefly shows "Synced N changes". Machine-specific things (email cache, model choices) deliberately don't sync; each Mac keeps its own.</p>`
        },
        {
            id: 'shortcuts', group: 'How it works', title: 'Keyboard shortcuts',
            blurb: 'The few keys worth knowing.',
            body: `
                <ul class="help-app-list">
                    <li><strong>Cmd+R</strong> — refresh (also pulls in sync changes from your other Macs)</li>
                    <li><strong>Esc</strong> — close the open post, menu, or overlay</li>
                    <li><strong>Enter</strong> in any quick-add box — create the item</li>
                    <li><strong>Cmd/Ctrl-click</strong> a launcher tile — open that app in a new window</li>
                </ul>`
        },
        {
            id: 'coding-agent', group: 'How it works', title: 'Build apps with a coding agent',
            blurb: 'Prefer a terminal? Point Claude Code (or any coding agent) at your apps folder.',
            body: `
                <p>You can build your own Anjadhe apps in a terminal with a coding agent — like Claude Code. They live in a plain folder on your Mac and Anjadhe loads them automatically.</p>

                <h4 class="help-heading">Where apps live</h4>
                <p>Turn on <strong>Build Apps</strong> in <strong>Settings</strong>. Anjadhe creates a folder in your home directory:</p>
                <ul class="help-app-list">
                    <li><code>~/Anjadhe/apps/</code> — one subfolder per app. Each has a manifest, the app's code, and its own saved data.</li>
                    <li><code>~/Anjadhe/apps/CLAUDE.md</code> and <code>AGENTS.md</code> — the full contract for building an app: the manifest format, the <code>Anjadhe</code> SDK (storage, navigation, tools), and worked examples. Both files hold the same instructions; a coding agent reads whichever one it looks for.</li>
                    <li><code>~/Anjadhe/apps/.anjadhe-schemas.json</code> — the shape of the built-in data (notes, goals, schedule, and so on) so an app can read it.</li>
                </ul>

                <h4 class="help-heading">Point a coding agent at it</h4>
                <p>Open the folder in your terminal and start your agent there:</p>
                <ul class="help-app-list">
                    <li><code>cd ~/Anjadhe/apps</code></li>
                    <li><code>claude</code> — or whatever launches your coding agent.</li>
                </ul>
                <p>Because <code>CLAUDE.md</code> / <code>AGENTS.md</code> sit in that folder, the agent picks up the whole contract on its own. Then just describe the app you want. For example:</p>
                <p><em>"Build a reading tracker app for Anjadhe. I want to add books with a title, author, and status (want to read / reading / finished), see them grouped by status, and mark one finished. Follow the manifest and SDK in CLAUDE.md, and save data with the Anjadhe storage API."</em></p>

                <h4 class="help-heading">It updates live</h4>
                <p>Anjadhe watches the apps folder. When the agent writes or changes a file, your app reloads on its own — no restart. A new app shows up as its own launcher tile next to the built-in ones.</p>
                <p>If an app has a problem, Anjadhe writes the error to <code>.errors.log</code> inside that app's folder. Point your agent at that file and it can read the error and fix itself.</p>
                <p>Each installed app is listed in <strong>Settings &rsaquo; Build Apps</strong> with a <strong>Reset Data</strong> button — it clears that app's saved data alone (the app stays installed; the reset syncs to your other Macs).</p>`
        },
    ],

    init() {
        this._bindOnce();
        this.render();
    },

    render() {
        const topic = this._topic ? this.TOPICS.find(t => t.id === this._topic) : null;
        const root = document.getElementById('help-root');
        const body = document.getElementById('help-topic-body');
        const heroTitle = document.getElementById('help-hero-title');
        if (!root || !body) return;

        this._teardownSpy();
        // The search stays; the "How can we help?" title is home-only.
        if (heroTitle) heroTitle.style.display = topic ? 'none' : '';

        if (!topic) {
            Breadcrumb.render('help-breadcrumb', [{ label: 'Help' }]);
            root.style.display = '';
            body.style.display = 'none';
            this._renderRoot();
            window.scrollTo(0, 0);
            return;
        }

        Breadcrumb.render('help-breadcrumb', [
            { label: 'Help', action: () => { this._topic = null; this.render(); } },
            { label: topic.group, action: () => { this._topic = null; this._section = topic.group; this.render(); } },
            { label: topic.title }
        ]);
        root.style.display = 'none';
        body.style.display = '';
        this._renderDoc(topic);
        window.scrollTo(0, 0);
    },

    // Icons for the section rail (matches the launcher's line-icon style).
    GROUP_ICONS: {
        'Your day': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
        'The assistant': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/></svg>',
        'Connected accounts': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/></svg>',
        'Apps': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>',
        'How it works': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4h6a2 2 0 0 1 2 2v14a2 2 0 0 0-2-2H2z"/><path d="M22 4h-6a2 2 0 0 0-2 2v14a2 2 0 0 1 2-2h6z"/></svg>',
    },

    _groups() {
        const groups = [];
        for (const t of this.TOPICS) {
            let g = groups[groups.length - 1];
            if (!g || g.name !== t.group) {
                g = { name: t.group, topics: [] };
                groups.push(g);
            }
            g.topics.push(t);
        }
        return groups;
    },

    // Root: the help home — a search over a two-pane section navigator (a
    // category rail and a grid of article cards). Typing swaps the panel for
    // flat search results.
    _renderRoot() {
        const list = document.getElementById('help-topic-list');
        const empty = document.getElementById('help-search-empty');
        if (!list) return;

        const q = this._query.trim().toLowerCase();

        if (q) {
            const matches = this.TOPICS.filter(t => this._haystack(t).includes(q));
            if (empty) empty.style.display = matches.length ? 'none' : '';
            list.innerHTML = matches.length ? `
                <div class="help-section-panel">
                    <h2 class="help-section-heading">${matches.length} ${matches.length === 1 ? 'result' : 'results'}</h2>
                    <div class="help-card-grid">${matches.map(t => this._cardHtml(t, q)).join('')}</div>
                </div>` : '';
            return;
        }

        if (empty) empty.style.display = 'none';
        const groups = this._groups();
        if (!this._section || !groups.some(g => g.name === this._section)) {
            this._section = groups[0].name;
        }
        const active = groups.find(g => g.name === this._section) || groups[0];

        list.innerHTML = `
            <div class="help-browse">
                <aside class="help-sections" aria-label="Sections">
                    <div class="help-sections-label">Sections</div>
                    ${groups.map(g => `
                        <button type="button" class="help-section-item${g.name === active.name ? ' active' : ''}" data-help-section="${UIUtils.escapeHtml(g.name)}"${g.name === active.name ? ' aria-current="true"' : ''}>
                            <span class="help-section-icon">${this.GROUP_ICONS[g.name] || ''}</span>
                            <span class="help-section-name">${UIUtils.escapeHtml(g.name)}</span>
                        </button>`).join('')}
                </aside>
                <div class="help-section-panel">
                    <h2 class="help-section-heading">${UIUtils.escapeHtml(active.name)}</h2>
                    <div class="help-card-grid">${active.topics.map(t => this._cardHtml(t)).join('')}</div>
                </div>
            </div>`;
    },

    _cardHtml(t, q) {
        const title = q ? this._highlight(t.title, q) : UIUtils.escapeHtml(t.title);
        return `
            <button type="button" class="help-card" data-help-topic="${t.id}">
                <span class="help-card-title">${title}</span>
                <span class="help-card-arrow" aria-hidden="true">&#8250;</span>
            </button>`;
    },

    // Detail: a doc-style page — left chapter rail, the body, an on-this-page
    // rail that scroll-spies the section headings, and prev/next.
    _renderDoc(topic) {
        const container = document.getElementById('help-topic-body');
        if (!container) return;

        const index = this.TOPICS.indexOf(topic);
        const prev = this.TOPICS[index - 1];
        const next = this.TOPICS[index + 1];

        container.innerHTML = `
            <div class="help-doc">
                <aside class="help-doc-nav" aria-label="Articles in this section">${this._railHtml(topic)}</aside>
                <div class="help-doc-main">
                    <header class="help-doc-header">
                        <h1 class="help-doc-title">${UIUtils.escapeHtml(topic.title)}</h1>
                    </header>
                    <div class="help-section help-doc-body">${topic.body}</div>
                    <nav class="help-doc-pager" aria-label="More articles">
                        ${prev ? this._pagerCard(prev, 'prev') : '<span></span>'}
                        ${next ? this._pagerCard(next, 'next') : '<span></span>'}
                    </nav>
                </div>
                <aside class="help-doc-toc"><nav class="help-toc" aria-label="On this page"></nav></aside>
            </div>`;

        // The privacy topic shows the live storage path.
        const pathEl = document.getElementById('help-storage-path');
        if (pathEl && window.electronStore?.getStorageFolder) {
            pathEl.textContent = window.electronStore.getStorageFolder();
        }

        this._buildToc(container);
    },

    // Left rail: the other articles in this article's section, current active.
    _railHtml(topic) {
        const siblings = this.TOPICS.filter(t => t.group === topic.group);
        return `
            <div class="help-doc-nav-label">Articles in this section</div>
            ${siblings.map(t => `
                <button type="button" class="help-doc-nav-item${t.id === topic.id ? ' active' : ''}" data-help-topic="${t.id}"${t.id === topic.id ? ' aria-current="page"' : ''}>
                    <span class="help-doc-nav-text">${UIUtils.escapeHtml(t.title)}</span>
                </button>`).join('')}`;
    },

    _pagerCard(t, dir) {
        const label = dir === 'prev' ? '&larr; Previous' : 'Next &rarr;';
        return `
            <button type="button" class="help-pager-card help-pager-${dir}" data-help-topic="${t.id}">
                <span class="help-pager-dir">${label}</span>
                <span class="help-pager-label">${UIUtils.escapeHtml(this._navLabel(t))}</span>
            </button>`;
    },

    // Give the section headings ids and build the on-this-page rail from them.
    // A single heading doesn't earn a contents list.
    _buildToc(container) {
        const bodyEl = container.querySelector('.help-doc-body');
        const tocNav = container.querySelector('.help-toc');
        const tocAside = container.querySelector('.help-doc-toc');
        if (!bodyEl || !tocNav) return;

        const headings = Array.from(bodyEl.querySelectorAll('.help-heading'));
        if (headings.length < 2) {
            if (tocAside) tocAside.style.display = 'none';
            container.querySelector('.help-doc')?.classList.add('help-doc--no-toc');
            return;
        }

        const used = {};
        const items = headings.map(h => {
            let id = this._slug(h.textContent);
            if (used[id]) { id = `${id}-${++used[id]}`; } else { used[id] = 1; }
            h.id = id;
            return { id, text: h.textContent };
        });

        tocNav.innerHTML = `
            <div class="help-toc-label">On this page</div>
            <ul class="help-toc-list">
                ${items.map(it => `<li><button type="button" class="help-toc-link" data-toc-target="${it.id}">${UIUtils.escapeHtml(it.text)}</button></li>`).join('')}
            </ul>`;

        this._setupSpy(items);
    },

    // Highlight the heading currently nearest the top of the viewport.
    _setupSpy(items) {
        const links = new Map();
        document.querySelectorAll('.help-toc-link').forEach(l => links.set(l.dataset.tocTarget, l));
        const setActive = (id) => links.forEach((l, key) => l.classList.toggle('active', key === id));
        setActive(items[0].id);

        const headings = items.map(it => document.getElementById(it.id)).filter(Boolean);
        this._spy = new IntersectionObserver((entries) => {
            const visible = entries
                .filter(e => e.isIntersecting)
                .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
            if (visible[0]) setActive(visible[0].target.id);
        }, { rootMargin: '-64px 0px -70% 0px', threshold: 0 });
        headings.forEach(h => this._spy.observe(h));
    },

    _teardownSpy() {
        if (this._spy) { this._spy.disconnect(); this._spy = null; }
    },

    // Short label for the rails and pager (title before the em dash).
    _navLabel(t) {
        if (!t._nav) t._nav = t.title.split('—')[0].trim();
        return t._nav;
    },

    _slug(text) {
        return text.toLowerCase().trim()
            .replace(/[^\w\s-]/g, '')
            .replace(/\s+/g, '-')
            .replace(/-+/g, '-');
    },

    // Lower-cased searchable text for a topic: title + blurb + body (tags stripped).
    _haystack(t) {
        if (!t._search) {
            const bodyText = t.body.replace(/<[^>]*>/g, ' ');
            t._search = `${t.title} ${t.blurb} ${bodyText}`.toLowerCase();
        }
        return t._search;
    },

    // Escape text, then wrap case-insensitive matches of the query in <mark>.
    _highlight(text, q) {
        const escaped = UIUtils.escapeHtml(text);
        if (!q) return escaped;
        const re = new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
        return escaped.replace(re, '<mark class="help-search-hit">$1</mark>');
    },

    _bindOnce() {
        if (this._bound) return;
        this._bound = true;
        document.getElementById('help-topic-list')?.addEventListener('click', (e) => {
            const section = e.target.closest('[data-help-section]');
            if (section) {
                this._section = section.dataset.helpSection;
                this._renderRoot();
                return;
            }
            const card = e.target.closest('[data-help-topic]');
            if (!card) return;
            this._topic = card.dataset.helpTopic;
            this.render();
        });
        // Detail view: chapter rail + prev/next open a topic; the contents rail
        // scrolls to a section (buttons, not #anchors, to stay clear of the
        // app's hash router).
        document.getElementById('help-topic-body')?.addEventListener('click', (e) => {
            const nav = e.target.closest('[data-help-topic]');
            if (nav) {
                this._topic = nav.dataset.helpTopic;
                this.render();
                return;
            }
            const toc = e.target.closest('[data-toc-target]');
            if (toc) {
                const el = document.getElementById(toc.dataset.tocTarget);
                if (el) {
                    const y = el.getBoundingClientRect().top + window.scrollY - 60;
                    window.scrollTo({ top: y, behavior: 'smooth' });
                }
            }
        });
        const search = document.getElementById('help-search');
        search?.addEventListener('input', () => {
            this._query = search.value;
            // Typing while reading an article jumps back to the search results.
            if (this._query.trim() && this._topic) {
                this._topic = null;
                this.render();
            } else {
                this._renderRoot();
            }
        });
        search?.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && search.value) {
                e.stopPropagation();
                search.value = '';
                this._query = '';
                this._renderRoot();
            }
        });
    }
};

AppManager.register('help', HelpApp);
