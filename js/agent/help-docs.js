/**
 * HelpDocs — the assistant's built-in knowledge of Anjadhe itself.
 *
 * This is the SOURCE OF TRUTH for app help. The website's help articles
 * (anjadhe-website/content/help/*.mdx) mirror these docs — a manual mirror,
 * same convention as the About view ↔ landing page. When a feature or a
 * Settings path changes, update the doc here first, then mirror the change
 * on the website. RELEASING.md has a per-release review step for this file.
 *
 * Served to the model one doc at a time via the get_help tool
 * (agent-tools.js, tool group 'help') — deliberately NOT injected into the
 * system prompt: the whole corpus is thousands of tokens and prompt-eval
 * dominates latency on local models. Slugs match the website's where a
 * counterpart exists ('ai-models' ↔ the site's 'cloud-models'; 'settings'
 * is app-only).
 *
 * Style: plain markdown, bold **Settings → …** paths so answers can cite
 * exact locations, no HTML, no emojis. Keep each doc under ~500 words —
 * these land in a 12B model's context as tool results.
 *
 * Each doc also declares `actions` — ids from HelpActions (help-actions.js)
 * naming the pages it sends people to. Those become the buttons under the
 * assistant's answer, so "open Settings → Accounts" is a click rather than
 * a scavenger hunt. Keep the list SHORT (2-4) and ordered by what the doc
 * is mostly about; the button row is capped and a doc that offers eight
 * doors offers none. When a doc's Settings path changes, the action id
 * changes with it.
 */
const HelpDocs = {
    docs: {
        'getting-started': {
            title: 'Getting started with Anjadhe',
            description: 'First steps: plan a project with the assistant, break it into tasks, connect Gmail/Calendar, enable AI.',
            actions: ['setup-checklist', 'connect-google', 'ai-models', 'goals'],
            content: `## Plan your first project

Projects live in **Tasks**, the one door that holds the whole framework. Open **Tasks** (press Cmd+K and type its name), then open the **Projects** page and click **"Help me plan a new project"** — the assistant walks you through it one question at a time: what you want to accomplish, what done looks like, by when — then proposes the first steps as tasks with dates for you to approve. You can also add a project by hand with **+ New project**.

Good projects are specific, finishable outcomes with a date, not vague wishes:

- "Run a 10K on October 18"
- "Ship v1 of the mobile app by end of Q2"
- "Save a 6-month emergency fund by December"

Less useful: "Work on the app", "Get healthier" — you can never check those off.

## Group your projects

Each project carries a plain **Group** label — Health, Work, Finance, Learning — and the Projects page shows projects grouped by it. There is nothing to manage: type a group name on a project (the field suggests existing ones) or drag a project onto a group in the sidebar. Three or four groups is plenty.

## Break projects into tasks

Tasks are the day-to-day actions that move a project forward. For "Run a 10K on October 18" that might be: "Sign up for the October 10K" (one-time, this week), "Run" repeating Mon/Wed/Sat at 7am, "Buy running shoes Saturday". The project interview proposes these for you; you can also type them into the quick-add box in plain language — "Run every mon wed sat 7am" — or open the project and click **Suggest tasks**. For recurring behaviors, a repeating task comes back on the days you choose and tracks your streak.

The **Tasks** app is the front door — it opens to Today, a short finishable list merging today's tasks, action items pulled from email, and your calendar. Tomorrow, This Week, This Month, Later, and each project group are one click away in its nav.

## Connect your tools

- **Gmail** — priority emails are analyzed by your own model, and action items are extracted directly into your task list.
- **Google Calendar** — see events alongside your tasks.

Open **Settings → Accounts** to connect. Services can be toggled off any time.

## Enable AI

Open **Settings → AI Assistant** to download a model (setup recommends one sized to this Mac's memory; local models are offered on Macs with 8 GB or more). Everything runs on this Mac by default. For more power — or on a Mac too small for any local model — use **+ Add model**: Anjadhe Cloud (hosted by Anjadhe, free monthly allowance, no key), your own OpenAI-compatible server, or an OpenAI/Anthropic model with your own API key. Always an explicit choice, never a fallback.

Everything else — Notes, Journal, Bookmarks, Portfolio — is optional; use only the parts that fit.

Every feature page has a small **?** in its header that opens that page's guide in place.`
        },

        'your-day': {
            title: 'Your day — Tasks & Projects',
            description: 'The Tasks app: Today list, quick-add in plain language, repeating tasks, overdue, weekly review, the Email AI app (every insight found in mail, incl. bookings), and the Projects page behind the Plan button (groups, projects, the project interview).',
            actions: ['tasks', 'goals', 'email-insights'],
            content: `**Tasks** is what to do now — it opens to Today. **Email AI** (its own app) is everything the assistant found in the user's mail. Planning lives one door away: the **Plan** button on the Tasks page opens **Projects** — projects grouped by the part of life they belong to, each broken into tasks. (Projects — formerly Goals — was a third tab until 2026-08-03; planning is a different altitude from doing, so it is a door rather than a peer.)

## Tasks — your day

**Today** merges tasks due today, anything overdue, repeating tasks, action items pulled from email, and today's calendar events. When everything is checked off it says so — "done for today" is a reachable state.

The nav beside the list filters the same system along dimensions that **combine**: **Dates** — Today, Tomorrow, This Week, This Month, Later (beyond this month, plus the undated backlog), All time — and **Groups** (your project groups), including a "No project" row for tasks linked to nothing. A **Tags** section appears once any task carries a tag: "All tags" plus one row per tag; picking one shows every task with that tag across all time. Tags are set in the task editor's Tags row — "+ Add tag" searches your existing tags and creates new ones in place — and tasks imported from Apple Reminders arrive tagged with their Reminders list name. An **Other filters** section appears once any task came from your mail: **From email** shows every task the email assistant created, across all time. Pick one of each (say Today + Health) and the list narrows to tasks under that group's projects. Pills above the list always show the active filters; the × on a pill clears just that one. Every view ends with a collapsed "N done" section of completed tasks — click it to expand.

**Row menu.** The ⋯ on a task row (or right-clicking the row) offers Open, Set date, Rename, and Delete — quick changes without leaving the list.

**Quick add.** Type into the "Add an action" box in plain language — "Call dentist tomorrow 3pm" becomes a task named "Call dentist", dated tomorrow, 3:00 PM. Dates, times, and repeat patterns ("Water plants every tuesday", "Pay rent monthly") are recognized as you type; chips under the box show what was understood before you press Enter.

**Overdue** shows above today's list. "Push to today" on the section header moves all of them; hovering a single row shows "→ Today" for just that one.

**Repeating tasks** come back on their schedule: daily, weekdays, a weekly day, custom days, monthly, annually. Checking one off completes it for today; tomorrow it returns.

**Complete vs. abandoned.** A task page has two honest buttons: Mark complete (did it) and Mark abandoned (deliberately not doing it). Both resolve the task the same way everywhere — an abandoned task checks off in every list, leaves the calendar, stops its reminders, and the assistant treats it as done rather than pending (it can also mark a task abandoned for you). Repeating tasks show a History of past occurrences. There are also reminders before the due time, a per-task work timer, and search.

**Edits save themselves.** Changes on a task's page save automatically as you type — there is no Save button on an existing task (only a brand-new task asks you to save once). "Back to list", Esc, or clicking any nav item returns to the list you came from.

**Weekly review.** The "Weekly review" link beside the Today pill runs a short guided review — what got done, what's stuck, what matters next week. It nudges at most once a week.

## Email AI — what your mail said

**Every** insight found in mail lands here, grouped by kind: a flight confirmation, a renewal date, a statement closing, a package arriving, a bill due Friday. Anything that needs doing *also* becomes a **task** on the Tasks tab, with a badge back to the email — and the insight here links forward to that task. The two answer different questions: Tasks is what you have to do, this is what your mail said. (Before 2026-08-03 an insight left this page the moment it became a task, which made it a page of leftovers; it was called "FYI" then.)

The sidebar groups them by what happened, one word each: **Bills** (money you owe), **Receipts** (money already paid), **Renewals** (things you have that renew or expire), **Appointments**, **Reservations** (trips and bookings you hold), **Deliveries**, **Deadlines** (something due back or due in, like library books), **Security**, and **Other**. Each folder states what belongs in it under its title, and a folder only appears when it has something in it. Marketing is not an insight: an offer to subscribe, upgrade or buy never lands here, however much it talks about renewals or discounts.

Items stay for **90 days** whether or not they have been read, so a hotel booked in June is still there the morning of the trip. Unread rows carry a dot, and the envelope button in the header narrows the page to them (the same control the Inbox has); older items stay findable through Email search and ⌘K. The left column says when the thing happens ("in 3 days"); rows whose mail carries no date of its own show, in italics, when it arrived instead.

Clicking a row opens it in the reading pane on the right (on a laptop-sized display the pane starts hidden and the row opens full width; the panel button in the header brings the pane back): the summary, the facts pulled out of the mail (a flight's route and times, a booking code, an amount), and the buttons to turn it into a task, mute the sender, or say it was not useful. "Open email" goes to the message itself. Drag the divider to set how wide the list is. Whole categories can be switched off in Settings, under Email.

**Trips.** Reservations that belong together — the flight out, the hotel, the rental car, the return leg — are grouped into a trip by their dates; nothing to set up. A coming trip appears as its own card on Home, and the **Trips** entry in the sidebar opens the index: trips coming up soonest first, past trips below. Opening a trip shows every reservation in it in one place, including bookings made months ahead whose email has long since left the 90-day window.

## Projects — the plan

Reached from the **Plan** button on the Tasks page; the back button in its header returns you there.

A project is something you can finish, with what "done" looks like, a target date, a **Group** label, and linked tasks. A project is either completed or it isn't — progress lives in its tasks (the n/m count on every project). The left nav lists your groups with their projects beneath, and the page shows one group at a time: pick a group to see its projects, then a project to see its detail and tasks.

**Plan a project by talking.** The "Help me plan a new project" button opens the assistant, which asks one question at a time — the outcome, the finish line, the date — then proposes 3-6 first steps as tasks with dates for you to approve. Stopping mid-conversation leaves a **draft** project; its "Finish planning it" button picks the interview back up. Projects can also be created and edited entirely by hand — every field saves as you change it.

**Groups are just labels.** A group exists because a project carries its name. Edit the Group field on a project (it suggests existing names), or drag a project onto a group in the sidebar. Feeling stuck is a conversation, not a label — the "I'm stuck" button hands the project to the assistant.

**Weekly AI reviews.** "Review it weekly" on a project schedules a routine that reads the project's linked tasks each week and posts a short honest read to the Home feed — moving, stalled, or done in all but name. On any project, **Suggest tasks** asks the assistant to propose next steps; nothing is added until confirmed.

## A worked example

One person's projects, end to end:

- **Work** (group)
  - Project: "Ship v1 by end of Q2" — tasks: "Fix login crash", "Draft release notes Friday", "Review PRs weekdays 9am" (repeating)
- **Health** (group)
  - Project: "Run a 10K on October 18" — tasks: "Sign up for the 10K this week", "Run every mon wed sat 7am" (repeating)
- **Home** (group)
  - Project: "Keep the house running" — repeating upkeep: "Water plants every tuesday", "Pay rent monthly"

Each quoted task above is literally what you'd type into quick-add — the dates, times, and repeats are parsed from the words. Note the shape: a few groups, one or two live projects in each, and repeating tasks carrying the routines. Projects change weekly, actions hourly — if the list is bigger than that, it's doing overwhelm's job for it.`
        },

        'the-assistant': {
            title: 'The assistant',
            description: 'What the AI assistant can do, memory, sources, long tasks, routines and the feed.',
            actions: ['ai-models', 'memories', 'routines', 'ai-activity'],
            content: `## What it does

The assistant is one chat that can: answer about your life (tasks, projects, notes, journal, email insights, calendar), do things for you (create tasks and notes, file action items, search the web, read pages, build documents and apps, and — if enabled in **Settings → AI Assistant** — work with files or browse), and answer anything general.

**Private by design.** The model runs on this Mac by default, on a server you own, on OpenAI or Anthropic if you added your own API key, or on Anjadhe Cloud if you chose it. Conversations and personal data go only to the brain you picked. Pick and manage models in **Settings → AI Assistant**.

**It knows Anjadhe, and it can take you there.** Ask how something works, where a setting lives, or what is left to set up ("am I connected?", "what should I do first?") and it answers from the built-in guide plus what this Mac actually has — connected accounts, the model in use, whether web search is on. Answers that point at a page carry buttons straight to it, so "connect Gmail" is a click rather than a hunt through Settings. The buttons only ever navigate: the page they open is where you decide.

**Name it.** You can give the assistant a name: first-run setup asks, and the **Name** field at the top of **Settings → AI Assistant** works anytime. The name replaces the "AI Assistant" label across the app, and the assistant knows it and answers to it. Clear the field to go back to the generic label; the name syncs to your other Macs.

**Sources.** When an answer used the web, a Sources row under it lists what was searched and every page actually opened — recorded from what the assistant really did.

**Memory.** The assistant keeps a small wiki of memory pages about you — who you are, how to help you, plus pages it starts on its own as new topics come up (a person, a project, a hobby). New facts land under **Recently learned** first, each anchored to the chat it came from and the words you actually said, then get filed into the right page; a quiet "Remembered: …" note appears under any reply that saved one. If it has something wrong, just say so in chat ("actually, it's X — update your memory") and it corrects the page right away — or click the fact under Recently learned and fix or delete it yourself. Click **memory** in the chat header to browse everything, search it, edit any page, pin a page so it rides into every chat, or add your own — your edits are kept and never overwritten. Memory is stored on your Macs and synced between them; the reading and filing runs on whatever model you've chosen, so with a cloud model (your own key) that processing happens there.

**Decisions.** A decision is a dated instruction pinned to one specific record — a strategy's "invest $2,000 monthly through October", a task's "never move this past Friday". When one gets settled in chat, the assistant asks before saving it (a "Noted on …" line confirms it), and from then on it re-reads that decision every time it works with the record, in any conversation. Each record's page shows its decisions — the task editor, a project, a strategy, a portfolio account, a routine — where you can add one by hand or delete one. Decisions sync between your Macs.

**Mention a record with @.** Type @ in any assistant message box to pull up your tasks, projects, notes, routines, strategies and accounts; keep typing to narrow, or make the first word a type ("@project marathon"). Picking one inserts its name and attaches the conversation to that record — the assistant sees its current state and its decisions from then on. A banner above the chat names the attachment, with an ✕ to detach.

**Attachments.** The + button on the message box (or drag and drop) attaches text files, CSVs, PDFs — and images, if the model can read them. Vision-capable models carry a "Reads images" badge on their card in **Settings → AI Assistant** (most OpenAI and Anthropic models qualify; local Gemma models need their vision file downloaded). On a model that can't view images, Anjadhe says so at attach time.

**Documents.** The assistant also opens documents it reaches itself — a PDF (scanned ones are read on this Mac), an Excel spreadsheet, a Word document, or an image, in a folder it has access to, on a web page, or attached to an email. On a model that can view images, an email's inline pictures and image attachments are read along with the email. It reads the contents rather than guessing from the filename, so "what did this statement charge me?" is answered from the statement.

**Routines — working while you are away.** Ask for something on a schedule ("every weekday at 7, check my portfolio against the news") or when something happens (an email arrives from a certain sender, with certain words in the subject, or mentioning something anywhere in the message — "an email with an invoice in it"; or a file lands in a folder) and the assistant offers to set it up as a routine. You approve it once — that approval is what lets it run with nobody watching — and from then on it runs by itself on this Mac. A routine either **writes you an answer** (it can read, never change anything, and each answer posts to your Home feed) or **takes actions**, which can change your data. The one you are approving is named in the confirmation. An action routine does not post to the feed — the feed is for things worth reading, not step-by-step logs; each run's log is kept on the routine's own page under **Run history**, and a run that fails also shows there as the routine's last problem. A routine that takes actions pauses and notifies you if a step needs permission, rather than guessing. The **Routines** page (Cmd+K, type "routines") lists everything armed, what triggers it, when it last ran, and anything **waiting on you**. Standing permissions — grants that let the assistant act without asking, each with optional limits (uses per day, an end date, exceptions such as "known email recipients only") and one-tap revoke — live in **Settings → AI Assistant**. When a limit runs out, the assistant asks instead of acting.

**Recipes.** When a task run finishes cleanly, a **Save as recipe** button appears on it. A recipe replays the exact steps that worked, with only the parts that vary (a date, a name) filled in fresh; every step still passes the normal permission checks. Ask for a recipe by name to run it. Saved recipes are listed under **Settings → AI Assistant → Recipes**.

**Undo.** Everything the assistant changes in your data or files is recorded. **Undo this turn** under a chat answer, or **Undo changes** on a finished task, puts things back. Anything you edited yourself in the meantime is skipped and reported, never overwritten. Actions that cannot be undone from here (a sent email, a calendar invite) are marked as such when you approve them.

**Long jobs run as tasks.** Ask for something big — "research all of these and build me a table" — and the assistant plans it as a task: you see the step plan, press **Run plan** to approve it, and it works through the steps with tools, checks its own work, and reports back. Nothing runs before you approve. You can also say "do it as a task" to route a request there explicitly.

**From the terminal.** Turn on **Settings → AI Assistant → Terminal Access** and click **Install command** to get the \`anjadhe\` command. Bare \`anjadhe\` opens an interactive session; \`anjadhe ask "question"\` is a one-shot; \`anjadhe task "goal"\` runs task mode. Same brain, same permissions — approvals appear right in the terminal — and the transcript lands in a "Terminal" conversation that stays on this Mac. Only this Mac can connect.

## Routines & the feed

A **routine** is a prompt that runs on a schedule (hourly, every 6h, daily, weekdays, or weekly, optionally at a set time like 8:00 AM) in the background on your local model and posts each result to the feed on the home page. (That is a routine that writes answers; a routine that **takes actions** keeps each run's log on its own page under Run history instead — the feed carries what your AI wrote, not what it did.) Manage them on the **Routines** page (reached with Cmd+K, or **Manage routines** on the home feed). You can also just ask the assistant in chat — "every morning, give me a list of Staff+ engineering jobs" — and it sets up the routine for you (you approve it first). Not sure what to automate? The **"Help me set up a routine"** button on the Routines page starts a short guided chat: the assistant explains what routines can do, asks one question at a time (what it should do, when it runs, whether it writes answers or takes actions), and builds the routine with you. Per-routine options: use personal context, allow web search, or plain offline generation. Anjadhe ships with starter routines already scheduled — Daily Briefing, News Digest, Daily Motivation, Weekly Reflection — edit, reschedule, or delete them freely. A prompt you run by hand instead is a **saved prompt**: it lives in the Notes app (New note → Saved prompt template) with a panel to run it in the AI Assistant or browser — schedule it there and it becomes a routine and moves to the Routines page. Open a feed post and **Discuss with Assistant** starts a chat with the result already in context. The feed groups posts by the routine that wrote them: one block per routine, showing the newest result with a line or two of what it says, and older results folded behind **Show N earlier**. Click a block to read the full post. **Unread / All** in the feed header switches between what still needs you and the whole history. Email insights are not in the feed; they appear on the home page above it. Anjadhe keeps the last 10 results per routine — pin one in the Notes app to keep it for good. A feed post and its routine link to each other: the post's meta line opens the routine on the Routines page, and the routine's page shows its recent runs. Links inside feed posts (and chat, notes, journal, bookmarks) open in Anjadhe's own browser with a "Back" strip to return where you were.`
        },

        'ai-models': {
            title: 'Choosing where the AI runs — local, your server, your own API key, or Anjadhe Cloud',
            description: 'The four homes for the model, switching the default model, adding an OpenAI/Anthropic key or Anjadhe Cloud, when a cloud model makes sense.',
            actions: ['ai-models', 'ai-activity'],
            content: `## Four homes for the brain

Every AI feature — chat, email insights, action suggestions, builds — runs on one model: the **default entry** in **Settings → AI Assistant**. It can live in four places:

1. **This Mac (default).** An open-weight model like Gemma or Qwen via the built-in llama.cpp engine. Free, offline, nothing leaves the machine. Offered on Macs with 8 GB of memory or more, sized to the machine: a light, fast model on an 8-16 GB Mac, larger ones from 32 GB up. The smaller the model, the simpler the tasks it handles well — Anjadhe Cloud is the stronger option for a small Mac, and setup suggests it below 8 GB.
2. **A server you own.** Any OpenAI-compatible endpoint you host — llama-server, vLLM, LM Studio on a homelab box.
3. **A provider you trust, with your own key.** The official OpenAI or Anthropic API, added as a model entry with a key from your own account. Frontier capability, at the cost of sending what runs on that model to the provider.
4. **Anjadhe Cloud.** An open-weight model hosted by Anjadhe, for Macs that can't run a capable model — no account, no key, a free monthly allowance of AI requests. What runs on it goes to Anjadhe's server (api.anjadhe.com), which forwards it to DeepInfra (deepinfra.com) under a no-retention agreement, without your identity; the service keeps usage counts, never what you asked, and its source code is public so that can be checked.

Every off-Mac option is an explicit choice — nothing ever falls back to a provider you didn't add.

## Adding a cloud model

1. **Settings → AI Assistant** → **+ Add model**. The page lists the homes
   on the left — **On this Mac** first when this Mac can run one, **Anjadhe
   Cloud** first on a Mac too small for any local model.
2. Pick **Anjadhe Cloud**, **OpenAI API**, or **Anthropic API**.
3. Anjadhe Cloud needs no key — pick a model when more than one is offered (each shows a short description of what it's good at) and click **Add**; you can add several and switch between them. For OpenAI/Anthropic, paste an API key from your account (platform.openai.com/api-keys or console.anthropic.com/settings/keys), click **List models** to fetch the live list your key can use, and pick one.
4. **Test** if you like, then **Add model**.

Make it the default via the radio on its card. You can keep local and cloud models side by side and switch from the model chip in the chat box. Keys are stored encrypted on this Mac, per model, and never sync — each Mac needs its own copy. The Anjadhe Cloud card's **Manage** panel shows how much of the monthly allowance is used.

## When a cloud model makes sense

On an 8–16 GB Mac the local models on offer are small and fast, and they handle everyday tasks — for harder work (long documents, multi-step tasks), Anjadhe Cloud is the no-setup upgrade, with a free monthly allowance — when it runs out, requests pause until the 1st. With your own key, be clear-eyed: what you run on that model goes to that provider under your account and their data terms, and usage is billed by the provider to you — Anjadhe adds nothing on top.`
        },

        'cloud-privacy': {
            title: 'Cloud privacy — what leaves this Mac when the AI runs elsewhere',
            description: 'What Anjadhe Cloud (or your own key/server) receives, what is stored, the Cloud Privacy switches for background work, the "Left this Mac" log, and how to check the server code.',
            actions: ['cloud-privacy', 'ai-logs', 'ai-models'],
            content: `## When the model runs off this Mac

With a local model nothing you do leaves the machine. When your default model is Anjadhe Cloud, your own OpenAI/Anthropic key or a server you run, every prompt goes there — the model has to read the text to answer. Anjadhe keeps that honest in four ways.

## 1. Chat sends what you typed; background work sends only what you allow

What you ask in chat goes to the model exactly as you typed it, with the context you attached. Anjadhe also does work without being asked: email insights, thread status, routines, reviews. **Settings → AI Assistant → Cloud Privacy** has one switch per kind of data that background work may send: Email, Notes, Journal, Wellness, Portfolio, Web pages, Files. **Journal and Wellness are off by default.** A switched-off kind stays on this Mac: the insight sweep pauses, a routine that tries to read it is told why, and AI Activity shows a "kept on this Mac" row so nothing is skipped silently. Asking about that data in chat still works. The switches sync between your Macs; they take effect the moment you pick a model that runs elsewhere.

## 2. Every request that left is listed

**Settings → AI Assistant → LLM Logs**, filter **Left this Mac**: each request with its destination, the exact messages it carried, and the reply. The list is built from the same object the app sent, so it cannot differ from what went out. The model chip in the composer carries a small arrow whenever the model runs off this Mac.

## 3. Less goes than you might think

Before an email body leaves for background analysis, quoted history, signatures and tracking links are stripped, and background prompts are capped in size. Anjadhe Cloud requests carry no account, name or email address — only a per-install key.

## 4. The server is checkable, not just described

Anjadhe Cloud runs on Anjadhe Connect (api.anjadhe.com), whose code is public. Prompts and answers are never logged or stored; a test in that code sends marked text through every path and fails if it shows up in a log line, an error body or the database. What is stored: request and token counts per install per month, keyed by a hash, deleted after 400 days. The Anjadhe Cloud card in **Settings → AI Assistant → Models** shows the commit the server is running so you can compare it with the public repository. Requests go on to DeepInfra (deepinfra.com), the inference provider, under a no-retention agreement; DeepInfra sees Anjadhe's server, never you. Any change to what is stored is announced at least 30 days ahead.`
        },
        'ai-activity': {
            title: 'AI Activity — see what the AI engine is doing',
            description: 'The AI Activity page: current and recent AI work, why the GPU is busy when you are not chatting, link to detailed LLM logs.',
            actions: ['ai-activity', 'ai-logs', 'ai-models'],
            content: `## What it shows

Open **AI Activity** with Cmd+K, or click the pulse icon in the titlebar — it pulses with an amber dot whenever AI work is running. The page shows what is using the AI engine on this Mac, as plain activities rather than logs:

- **A status line** — whether the engine is idle, running tasks, or loading a model, and which model is currently held in memory.
- **Happening now** — requests in flight, with a live timer. Routines waiting their turn behind your chat show as "waiting its turn".
- **Recent** — the last activities with status, model, duration, and when they ran. Rows marked **automatic** are work the app started for you.

## Why is the GPU busy when I'm not chatting?

Anjadhe runs AI in the background on your behalf: email insights and bundling after a mail sync, routines, memory tidy-ups after a chat, goal-progress updates, and model warm-ups (loading the model so your first message answers fast). Loading a model into memory is itself the heaviest moment for the GPU, even before any request runs. All of it shows on this page, so a busy GPU always has a visible reason.

Each activity happens on whatever model you chose — local by default; requests only go to a server or cloud model if you made one your default.

## From activity to full detail

Click a row to open the exact request in **LLM Logs** (full prompt, response, and token counts), or use **Open detailed logs** for the whole list. The activity list is per-Mac and does not sync; **Clear** empties it without touching the logs.`
        },

        'web-search': {
            title: 'Web search — opt-in, private by design',
            description: 'Web search is off until enabled (setup or Settings); Anjadhe Connect, what leaves the Mac, switching to your own key, search logs.',
            actions: ['web-search'],
            content: `## Off until you turn it on

Web search is an explicit opt-in: the first time the assistant wants to search, it asks with the exact query on screen — approving that first search turns web search on — and the **Enable web search** switch at the top of **Settings → AI Assistant → Web Search** turns it on or off anytime. When it is off, nothing in Anjadhe sends queries to the web — the assistant answers from the model alone, and News and routines work from local data only. When enabled, the built-in option is **Anjadhe Connect** (api.anjadhe.com), a small relay Anjadhe runs, which forwards the query to a search provider and returns the results. 300 searches a month are included — no account, no key to paste.

## What the relay sees — and what it keeps

A web search means the query leaves this Mac; the relay is built so that is ALL that happens:

- It stores a **count** of searches per installation — not the queries. Nothing you search is logged or kept.
- The search provider on the other side sees queries arriving from Anjadhe's server, mixed in with everyone else's — not your name, account, or address.
- The relay's source code is public, so this can be checked rather than believed.

Documents, email, and notes never ride along — only the query itself.

## Prefer Anjadhe out of the loop? Use your own key

The **Tavily** and **Brave Search** cards (Settings → AI Assistant → Web Search) send searches straight from this Mac to that provider — no Anjadhe relay involved. Create a free account (Tavily includes 1,000 searches a month, no credit card), paste the key on the card, **Save Key**, then **Test**. Keys are stored encrypted on this Mac and never sync — paste the key on each Mac you use.

## Check what left this machine

A Sources row under web-assisted answers lists what was searched and every page opened, and **Settings → AI Assistant → Web Search Logs** records every query that left this Mac — whichever provider handled it.`
        },

        'news': {
            title: 'News',
            description: 'Following topics: the News timeline, article reader, Catch me up digest, dates to Schedule, topics and location, "show fewer like this".',
            actions: ['news', 'web-search'],
            content: `## Turn it on

News needs web search enabled (**Settings → AI Assistant → Web Search**). Then pick topics with the **Topics** button on the News page. Pick from the suggestions or add your own ("San Francisco city updates"). An optional **Location** adds local news. Headlines refresh when you open News, not in the background.

## The News page

**News** (Cmd+K, then "news") is a single timeline of current headlines for your topics, newest first — each post shows the source, its topic, and how old it is. The topics rail on the left drills into one topic; "← All news" comes back. Headlines come straight from news feeds; no AI writes them. Stories you have already opened dim. The **search box** in the header filters the current headlines (the last 48 hours of every followed topic) and your Saved stories by title, source, or topic; it searches what the page holds, not the web.

Clicking a headline opens the **reader**: the article is fetched and summarized on your Mac, with **Open article** for the original page and **Ask about this** to discuss it with the assistant. That chat starts with the article's text itself in context, and when web search is on the assistant also searches for background or newer developments instead of relying on what it remembers. When the AI spots upcoming dates in an article (an event, a deadline), it offers **Add to Schedule** — checked by you before you rely on it.

**Save** in the reader keeps a story for later. Saved stories are listed under **Saved** in the topics rail, and they stay there after the headline drops out of the feed, so the reader can open them again days later. The × on a saved row removes it, and your saved list syncs between your Macs.

## Catch me up

The assistant can read these headlines too — ask it "what's the news?" and it summarises your followed topics rather than searching the web. The **Morning News** routine does the same thing at 7am and posts the digest to your home feed (edit or reschedule it under **Manage routines**).

**Catch me up** (on the News page) writes a short AI digest of the current headlines, on your Mac. It needs an AI model set up.

## Make it yours

The × on any story means show fewer like this — ranking learns from it, and hidden stories can be restored from the Topics dialog. Stories boosted toward your interests carry a "For you" label with the reason. Clicks, hides, and ranking all stay on this Mac; the model never chooses or writes the headlines you see.`
        },

        'connected-accounts': {
            title: 'Connected accounts — Email, Calendar, Apple apps & iMessage',
            description: 'Connecting Gmail and Google Calendar, email bundles/insights/action items, the calendar lens, importing Apple Reminders, Notes and Calendar, and getting this Mac\'s notifications by iMessage.',
            actions: ['connect-google', 'accounts', 'inbox', 'email-insights'],
            content: `## Email insights

Connect Gmail (**Settings → Accounts**, or the gear in the Inbox header) and mail syncs from Google's servers straight to this Mac — no service in the middle.

- **Bundles** — categorical mail (newsletters, promotions, receipts) is grouped into a handful of piles, each a card showing the pile's name, when its newest mail arrived, and who has been writing lately. Click a card to see only that mail; the breadcrumb at the top names where you are, and clicking "Inbox" takes you back. Inside a bundle, a row of buttons above the list acts on the whole pile: mark all read, mark all unread, archive all. Personal mail is never sorted into a topic bundle: it sits in "Unbundled", the first card.
- **Needs reply / Waiting on them** — the top two rows of the Inbox sidebar, above the labels. "Needs reply" is mail a person sent you, still in the inbox, that you have not answered. "Waiting on them" is mail you sent that has had no answer for more than three days. Both are worked out from the threads themselves — who wrote last, and how long ago — so nothing is guessed and no reminder has to be set. Both clear themselves: reply and it leaves the first list, they reply and it leaves the second, and archiving a thread takes it off both. Bulk mail, newsletters and no-reply addresses never appear.
- **View toggles** — two icon buttons in the header. The envelope filters the list to unread mail only. The stack turns bundling off, for one flat list of everything in date order. Both remember their setting on this Mac. A message opened in the reading pane marks itself read after a second, so a skim past it does not clear it, and the row you are reading stays in place while it is open; a message opened full-width (reading pane off) is marked read right away.
- **Reading pane** — on a large monitor the inbox is two panes: the list on the left, the message on the right. Click a row to read it, click another to move on. Drag the divider to resize (double-click it to reset), and use the panel button in the header to hide the pane when you want the full-width list. On a laptop-sized display the pane starts hidden, so a message opens full width with a way back to the list; the same button turns the pane on, and the choice sticks on this Mac. The page itself never scrolls: the sidebar, list, message, and insights each scroll on their own. The hamburger beside the Inbox title folds the Labels and Accounts sidebar away.
- **Finding mail** — the search box in the header matches your words in any order across sender, subject, snippet, and the bodies of mail already synced to this Mac. Typos of one letter still match on longer words, accents fold ("jose" finds José), "quotes" force an exact phrase, and you can narrow with \`from:\`, \`to:\`, \`subject:\`, \`is:unread\` or \`is:read\`. Ask the assistant instead if you would rather not scan the results yourself: it searches the same way and can pull older mail from Gmail once you confirm how far back to go.
- **Insights** — the AI reads important mail and writes short summaries of what matters. Click one (in the Email AI app, or its card on home) to open its detail page: summary, action items linked to their tasks, feedback buttons, and the underlying email. Opening an insight marks it read. Marking one "not useful" teaches it: enough votes stop that kind of insight from that sender — but insights that need action from you always come through (only Mute silences a sender). Everything it learned to skip is listed under Email Settings › Skipped insights, each with a "Show again" undo; right-click an email in the inbox list and choose "Analyze with AI again" to re-run one message after unlearning.
- **Action items** — deadlines, renewals, RSVPs found in mail become tasks automatically, with a source badge linking back to the email. Confirm or dismiss; never retype.

Each Mac syncs mail independently (Gmail is the source of truth), and analysis happens on your own model.

## Calendar

The Calendar shows scheduled tasks and Google Calendar events on one timeline — month, week, or day. It is a lens: tasks live in Tasks, events live in Google; the calendar lets you see time. Connect Google Calendar in **Settings → Accounts**. Today's events also appear at the bottom of the Tasks Today page.

With more than one calendar account connected, the rail on the left scopes the grid to a single account; "All accounts" brings the rest back, and the hamburger beside the title folds the rail away.

- **Tasks on the same days** — anything you schedule in Tasks shows on the calendar too, so the grid works without any account at all. The **Tasks** checkbox in the header hides them when you only want events.
- **Google round-trips** — new events, edits, deletes and recurring events (the form's Repeat row; an instance asks whether the change is for this event or the whole series) all write back to Google. Apple calendars are a read-only mirror (see below).
- **Ask about any event** — open an event and use "Ask about this event…" to hand it to the assistant; the conversation already knows which event you mean.

## Apple Reminders, Notes & Calendar

**Settings → Accounts → Apple apps** imports what this Mac's own Apple apps already hold — no Apple ID or password involved, just a one-time macOS permission prompt. Each import is a separate switch:

- **Apple Reminders → Tasks** — every open reminder becomes a task, with its due date, time, and repeat (daily, weekly, monthly, yearly). Each task is tagged \`apple-reminders\` plus the name of its Reminders list, and a list picker under the switch chooses which lists to import. Completing a reminder in Apple Reminders marks the task done here on the next import.
- **Apple Notes → Notes** — notes come across with their text, tagged \`apple-notes\`. Locked notes are skipped. Turn this on for ONE Mac only; imported notes reach your other Macs through Anjadhe's own sync.
- **Apple Calendar → Calendar** — events from this Mac's iCloud and local calendars appear in the Calendar as a read-only mirror, with their own "Apple Calendar · this Mac" row in the accounts rail. Google-account calendars in the Mac's Calendar app are deliberately left out — Anjadhe syncs Google Calendar itself.

All three are one-way: nothing is ever written back to the Apple apps. Imports run when the app opens, plus an **Import now** button on each row. A note or task you edit in Anjadhe keeps your edit — later changes on the Apple side no longer touch it. **Turning a switch off removes what it imported** (everything stays in the Apple app; turning it back on brings it all back).

## Telegram

Chatting with this Mac's assistant from the Telegram app has its own guide: ask for the **telegram** help topic. Its card is in **Settings → Accounts → Telegram**.

## iMessage

**Settings → Accounts → iMessage** sends this Mac's reminders and alerts to your own iMessage — a text from you to you, through the Messages app on this Mac, so it reaches your iPhone and Apple Watch with Apple's own end-to-end encryption and no bot or server in between. Enter the phone number or email you use for iMessage, press **Send a test** (the first send asks macOS for permission to let Anjadhe control Messages), then turn the switch on. Messages on this Mac must be signed in to iMessage. This is one-way: the assistant does not read your iMessages, and it does not answer them — use Telegram or the Anjadhe phone app to chat with it from your phone.`
        },

        'telegram': {
            title: 'Telegram — chat with this Mac\'s assistant from your phone',
            description: 'Setting up Telegram step by step: create your own bot with @BotFather, connect its token in Settings → Accounts → Telegram, link one chat with the pairing code, what the assistant can and cannot do from Telegram, forwarding this Mac\'s reminders there, one-Mac rule, privacy, unlinking and disconnecting.',
            actions: ['telegram', 'accounts'],
            content: `## What it is

**Settings → Accounts → Telegram** lets you message the assistant that runs on this Mac from the Telegram app on any device. You bring your own bot, so nothing is shared with anyone else's: your messages go from Telegram to this Mac, run on your own AI model with the assistant's tools, and the reply comes back in the same chat.

## Set it up

1. **Create a bot.** In Telegram, open **@BotFather** and send it \`/newbot\`. Give the bot a name and a username. BotFather answers with a **token** (a long string with a colon in it). Copy it.
2. **Connect the token.** In Anjadhe, open **Settings → Accounts → Telegram**, paste the token into the field and press **Connect**. The card now shows your bot's name and username.
3. **Link your chat.** Press **Link your Telegram**. The card shows a short **pairing code**. In Telegram, open a chat with your bot and send that code as a message. The chat that sends it becomes the one this Mac answers — exactly one chat, ever. **Cancel** on the card abandons the code.
4. **Switch it on.** The switch at the top of the card turns listening on and off. When it is on the card reads "Listening for messages"; when it is off, messages sent to the bot are not received.

Set this up on **one Mac only**. Telegram allows a single listening app per bot, so a second Mac connected to the same bot would take the messages away from the first.

## What the assistant can do from Telegram

The same assistant as on the Mac, with its tools: it can read your data and answer about it, and add tasks or notes. Anything that would need your confirmation on the Mac — deleting, sending, spending — is declined in Telegram and has to be done here. Message text is never written to this Mac's logs.

## Get reminders there too

Once a chat is linked, a second switch on the card, **Send this Mac's notifications there too**, forwards reminders and alerts to the linked chat. Each arrives under a bold header such as "Anjadhe · Reminder" (or Task, Routine, Email), so it never reads like a reply from the assistant.

## Privacy

Messages and replies travel through Telegram's servers, like any Telegram message. The bot token is stored encrypted on this Mac. Only the linked chat is answered; a message from any other chat is ignored.

## Changing or removing it

- **Unlink** forgets the linked chat, so you can link a different one.
- **Disconnect** removes the token and the linked chat from this Mac. The bot itself lives in your Telegram account; delete it with @BotFather (\`/deletebot\`) if you no longer want it.`
        },

        'everyday-apps': {
            title: 'Everyday apps — Notes, Journal, Bookmarks, Wellness, Portfolio',
            description: 'The capture and reference apps: note templates, journal moods, bookmark grid, wellness health log, portfolio accounts and prices.',
            actions: ['portfolio', 'customize-home-apps'],
            content: `## Notes

A three-pane notebook: filters on the left, the note list in the middle, and the note itself — always open, always editable. No Edit/Save buttons; changes autosave as you type.

- **New notes** — the "+ New Note" button in the header opens a blank note straight away.
- **Panes** — three icon buttons in the header, each a small map of the page with the pane it hides or shows shaded: the filters sidebar, the note list, and the reading pane. With the reading pane off the list takes the full width, and opening a note swaps to the full-width note with a back chip naming the list you came from ("← Pinned", "← work"). The reading pane starts off on a laptop-sized display and on in front of a large monitor; Journal makes the same call. Each choice is remembered on this Mac, and the dividers between panes drag to resize.
- **Finding a note** — global search (Cmd/Ctrl+K) searches note titles and bodies along with everything else; the Notes page itself has no separate search box.
- **Formatting** — select text for a small toolbar (bold, italic, headings, quote, lists, link, and **T** for normal text), or type / on an empty line for the block menu. Markdown shortcuts work as you type (# for a heading, - for a list), and text pasted from a markdown file keeps its headings, lists, code blocks and emphasis.
- **Images** — paste an image or screenshot straight into the note body; it is stored inside the note (scaled down to keep notes light) and syncs with it.
- **Your notes are files.** Every note is also kept as a plain Markdown file in the Anjadhe folder of your home directory (\`~/Anjadhe/Notes/\`, images beside it in \`assets/\`), and every journal entry in \`~/Anjadhe/Journal/\`. Open them in Finder or any editor, including Obsidian: edits you make to the files show up in Anjadhe, and edits here are written back. A file you rename keeps its name. The switch and an Open Folder button are in **Settings → Storage & Backup → Notes and Journal as Files** (on by default, per Mac).
- **Wiki links** — type [[ inside a note to link another note by title (or create one on the spot). A note lists what points at it under "Linked from", and notes sharing a tag appear as Related notes.
- **Tags** — click a tag pill on a note to see every note with that tag; the "Find a tag…" box in the sidebar narrows the tag list as you type.
- **Templates** — a note can be Blank, a Book (chapters behind the "Chapters" toggle), or a Prompt (a reusable instruction the assistant can run on a schedule — settings behind the "Settings" toggle).
- **AI Assistant notes** — notes the assistant writes are typed "AI Assistant" with a sparkle chip; the sidebar has a filter for them.
- **Define** — select a word in any note to look it up in place.

## Journal

Dated reflection: one or more entries per day, each with an optional mood. Read as a list or flip through the diary view. The assistant can read the journal on request ("how was my week?") and write entries ("journal this: …"). A gentle home-page nudge appears if you haven't written today.

## Bookmarks

Bookmarks live inside the **Web Browser**: every new tab shows your bookmarks, the star in the toolbar saves the current page, and **Manage** on the new tab's Bookmarks section opens the full Bookmarks page — save links with a title and tags, browse as grid or list. (Cmd+K also finds "Bookmarks" by name.) Clicking a bookmark opens the page in the browser; the i button on a card opens its details instead. The assistant can save bookmarks and pull them into research.

## Wellness

One place to log health data: blood pressure and pulse, resting heart rate, weight, blood glucose, SpO2, temperature, meals, water, activities with heart-rate data, steps, sleep, mood/energy/stress, medications, and symptoms. The **+ Log** button opens a grouped menu; every entry lands in a per-day timeline. Blood pressure and glucose entries show how long after the last meal and activity they were taken (log the meal first, then the reading). Trend charts cover BP (with 120/80 reference lines), pulse, weight, glucose, sleep, water, mood, and steps over 2 weeks to all time. Units (lb/kg, mg/dL/mmol/L, F/C, oz/ml) switch from the Units button. The assistant can log entries ("log my bp 122 over 79"), list them, and summarize trends via the wellness tools.

## Portfolio

Track investment accounts (brokerage, 401k, IRA, HSA…), holdings, properties, and liabilities (mortgages, loans, credit lines). Prices refresh from Yahoo Finance; cost basis uses the average-cost method; a value-history chart shows the trend. The **Show/Hide** button in the header blanks all dollar values; Snapshot saves today's total to the history. Stored locally like everything else.

- **Accounts** — the left nav lists All Accounts plus each account with its value. Click one and the whole page scopes to it: its total, chart, holdings, and transactions, with Cash, Edit, and Delete in the header.
- **Holdings and transactions** — two tabs, at every scope. Holdings is one simple row per position; Transactions lists every buy and sell, with the account named on each row when you are looking at all accounts.
- **Properties and liabilities** — the left nav lists your real estate and your debts under Accounts, each with its value or balance, with **+ Add property** and **+ Add liability** rows. A liability is a mortgage, home equity line, auto, student or personal loan, credit card, or anything else you owe: balance, lender, rate, monthly payment, and optionally the property it is secured by. Both also appear as sections on the All Accounts view; the property page shows its mortgage and the equity left. The summary at the top is one number over a composition bar and legend that read as the equation behind it (investments + cash + real estate − debt); once any debt is on the books that number is labeled net worth. Liabilities sync between your Macs and count in the assistant's portfolio answers.
- **Watchlist** — follow tickers you don't own. **+ Add ticker** in the Watchlist section (All Accounts view) searches by symbol or company name; each row shows the live price and day move and opens the same detail page a holding gets. On any stock's detail page, **Watch** in the header adds or removes it. The watchlist syncs between your Macs.
- **Ticker detail** — every stock's page shows the company profile, a real market price-history chart (1M to Max ranges from Yahoo Finance, not just prices since you added the position), and **Open in** pills that jump to the ticker on research sites (Yahoo Finance, TradingView, Finviz…) in your browser. Holdings also get your own value history and per-account position tables.
- **Options** — long calls and puts are tracked next to stocks. In the transaction editor, switch from Stock to Option and fill in the underlying, call or put, strike, and expiration; quantity means contracts and price means premium, and the 100x multiplier is applied for you. Positions read as "AAPL $250 Call 12/18/26" with an expiry note that turns amber near expiry and red once expired. Short and written options are not supported.
- **News on your holdings** — a ticker's page lists recent headlines about that company, and the account pages and All Accounts collect headlines across the holdings (largest positions first; index funds are left out so companies are not crowded out). A headline opens the News reader with a summary written on your Mac, and its back button returns to Portfolio. Needs web access on; the assistant reads the same headlines when you ask about a stock or when the Market Review runs.
- **Prices** — quotes include pre-market and post-market moves when the market is closed. For shares you bought today, day change is measured from your purchase price rather than yesterday's close.

### Strategy

A strategy is the plan behind the holdings: what the money is for, when you need it, how big a drop you can sit through, a target mix, and the limits you want to hold yourself to. **Plan** in the accounts nav opens it. The quiet strategy line above your holdings goes to the same place, and at account scope it says whether that account has its own plan or follows the overall one.

The Plan page is for reading, not filling in. It shows the plan in your own words, a **target mix** table (each sleeve with its tickers, target against actual, a bar marking the tolerance band, and what to trim or add in dollars to get back to target), a list of your **guardrails** with a pass or fail beside each, and a one-line verdict: On plan, Drifting, or Off plan. Every number there is computed by the app, using the same arithmetic the assistant and the home widget use, so the page and the chat can never disagree. Anything that changes the plan is a button that hands the question to the assistant, and **Ask about this strategy** opens a chat with that plan already in context. **Review it every weekday morning** schedules a routine whose latest read appears beside the plan.

Click a plan's **name** to open the plan's own page: everything above plus the accounts actually following it (each a link to that account) and the plan's change history. The questions offered there fit the plan's state — a draft offers to be finished, a drifting plan offers the way back to target.

You do not fill in a form. Ask the assistant to build one and it interviews you, one question at a time, explaining why each part matters, because most people have never been asked these questions. It proposes a target mix based on your answers and what you already hold, you correct it, and it saves the plan. An interrupted conversation leaves a draft you can pick up later.

Once saved, the plan is measured against your real holdings: on the Plan page, whenever you ask the assistant, and in the home widget. Adding a transaction that puts you off plan says so at the time, and the daily Market Review (below) names any drift after the close.

Accounts follow the overall strategy unless you tell the assistant to give one its own. That helps when, say, a Roth should be judged differently from a taxable account.

### Scheduled review

A **Market Review** routine reviews the portfolio each weekday and posts to the Home feed shortly after the US market closes, at the matching time in your own timezone (4:30 PM Eastern is 1:30 PM in California). It covers the day's result, your best and worst positions, cash, whether you are still on plan, and any headlines that touch your holdings. It runs on your own model with read-only tools, skips weekends, and stays quiet when there is nothing to say. Edit the time or turn it off in the Routines app.`
        },

        'how-anjadhe-works': {
            title: 'How Anjadhe works — privacy, sync, and building your own',
            description: 'Where data lives, multi-Mac sync, keyboard shortcuts, Documents, your writing voice, building apps with a coding agent.',
            actions: ['storage-backup', 'privacy-security', 'developer', 'ai-logs'],
            content: `## Privacy & your data

Anjadhe is private by default. No remote database, no account. Data is stored on this Mac in the standard macOS Application Support area. AI runs where you choose — this Mac (default), a server you own, OpenAI/Anthropic with your own key, or Anjadhe Cloud if you chose it. Backups and storage location live in **Settings → Storage & Backup**. Transparency logs of every AI call and web search are in **Settings → AI Assistant → Logs** — machine-local, never synced.

## Sync

**Sync.** Off by default — your data stays on this Mac until you turn sync on (setup asks, or **Settings → Storage & Backup → Sync Between Macs**). When enabled, changes travel between your Macs through your own iCloud Drive, encrypted. Merging happens on app start or refresh (Cmd+R) — never mid-work — and the titlebar briefly shows "Synced N changes". Machine-specific things (email cache, model choices, API keys) deliberately don't sync.

## Getting around

**The sidebar** down the left lists every app, grouped by what it is for, and marks the one you are in. **Home** is its first row. **Collapse** at the bottom narrows it to icons when you want the room back — it stays that way until you expand it, on this Mac only. **Customize** beside it opens the same show/hide list as Settings → Appearance; an app you hide leaves the sidebar but stays findable by name in Cmd+K.

The titlebar carries the rest: the **Anjadhe** wordmark is the way home from anywhere, the grid button beside it opens the same list as a quick popover, and the button on the far left goes **back to where you came from**, naming it.

## Keyboard shortcuts

- **Cmd+K** — the launcher and search in one. It opens with your most-used apps listed; type to narrow to any app, or to a note, task, project, journal entry or bookmark by name.
- **Cmd+/** — open the assistant panel over whatever you are looking at
- **Cmd+R** — refresh (also pulls sync changes from other Macs)
- **Esc** — close the open post, menu, or overlay
- **Enter** in any quick-add box — create the item

## Documents and your writing voice

**Documents** — the user's repository for their digital documents (PDFs, scans and photos of paper read with the Mac's own OCR, spreadsheets, Word/PowerPoint files, RTF, web pages, notes), parsed and indexed on this Mac and ORGANIZED WITH TAGS. Import files, drag-drop anywhere on the page, or Finder-drop into the folder (~/Anjadhe/library/); supported: .pdf, .png/.jpg/.heic and other images, .docx/.doc/.rtf/.odt, .xlsx/.csv, .pptx, .md/.txt/.html. **Tags**: hover a row → "+ tag", or the tag strip while reading; a slash makes a level ("Finance/Taxes/2025" shows under Finance, Taxes and 2025 in the tree on the left); click a chip to filter, × to remove, "Rename tag" renames it everywhere; to create a child tag, hover a tag in the tree and click its "+" ("+ New" at the top for a top-level one), name it, and it is selected and ready — drop files on it (or anywhere while it is selected) to import them tagged, drag a document row onto it, or hover a row and click "+ tag" (the picker starts with the selected tag's path); "Untagged" collects what still needs filing. Searching shows passages grouped by document (inside the selected tag when one is chosen); opening one shows the text — TIDIED WITH AI once per document (paragraphs rejoined, headings/tables restored, nothing summarized or added; saved once as a Markdown sidecar in the folder's hidden .anjadhe/tidy so it is never regenerated for an unchanged file, on any Mac sharing the folder; automatic when the AI model is on this Mac, otherwise a "Tidy with AI" button unless Files may leave this Mac in Cloud privacy) — or, when the AI model can SEE images (a local model with its vision file, or a vision-capable cloud model), READ FROM THE PAGE IMAGES by the vision model (far more accurate than the PDF text layer; that transcription becomes the document's text for search and the assistant; first 25 pages automatic, the rest on a click; a document parsed or OCR'd earlier shows "Re-read with vision" in the banner to reprocess it) — with a banner saying which view is up and "Show extracted text" to flip back (matches are marked in the extracted view) — plus Open original / Show in Finder / Ask about this document (the assistant then knows what's open; it always reads the extracted text, never the rewrite). The assistant can search (search_library, optionally within a tag), list by tag (list_documents), read a document (read_library_doc) and tag documents on request (tag_document). Cmd+K finds documents by title or tag. Deleting a document moves the file to the macOS Trash. Semantic search needs a one-time ~330 MB model download in **Settings → Documents** (also index status, Rescan/Re-index, the folder location); until then search is keyword-only. Parsing, OCR and indexing always run locally — only passages retrieved for a question travel with that chat turn. Tags sync between Macs (the index is rebuilt on each).

**Writing voice** — the assistant can learn how the user writes and draft in their voice WHEN ASKED. It is a setting, not an app: **Settings → Writing voice**. Turn it on and pick what it learns from — documents you add (Add documents… or drag-drop onto the page), your Notes, your Journal, and your **sent emails** (only the parts you wrote: quoted replies, forwarded messages and signatures are stripped before anything is studied). Each source is a switch you can change any time; nothing is read until you press **Study**. Study reads a spread sample on the AI model you chose (**Study depth** on the same page sets how much) and writes a short, editable style guide plus verbatim passages of your writing. Edits to the guide stick — re-studies never overwrite them — and passages can be pinned or removed. To use it, ask any chat: "write this in my voice", "make it sound like me", "reply the way I would" — the assistant fetches the guide and passages first, then writes; **Draft in my voice…** on the settings page opens a chat already primed. There is one voice, the user's own; voices built from other people's writing are not a feature. Routines and other automatic writing use the assistant's own voice. **Turn off** removes the guide and passages; documents, notes, journal and emails stay where they are. No fine-tuning, no hidden style profile: the guide is a page the user can read and change. Documents given to the voice are also visible in the Documents app — same folder.

## Build apps with a coding agent

Prefer a terminal? Turn on **Build Apps** in **Settings**. Anjadhe creates ~/Anjadhe/apps/ — one subfolder per app, plus CLAUDE.md / AGENTS.md holding the full contract (manifest format, the Anjadhe SDK, worked examples) and .anjadhe-schemas.json describing built-in data shapes. Start your coding agent in that folder and describe the app; the agent picks up the contract on its own. Anjadhe watches the folder — changes reload live, and errors are written to .errors.log inside the app's folder so the agent can read and fix them.`
        },

        'license': {
            title: 'License — what Anjadhe costs and the free-for-good alpha license',
            description: 'Pricing (free during alpha; a one-time license with a year of updates and no account planned later, price not set yet), the alpha license everyone who installed during the alpha keeps for good, how to claim or enter a key, what a license does and does not do.',
            actions: ['license', 'setup-checklist'],
            content: `## What Anjadhe costs

Anjadhe is free during the closed alpha. The plan after it is a **one-time license** with a year of updates, then paid upgrades if you want later years; there is no subscription for the app and no account. The price is not set yet. **Everyone who installs during the alpha keeps the app free for good.** Hosted extras (web search through Anjadhe Connect, Anjadhe Cloud models) keep a free monthly allowance; only usage beyond it would ever be paid, and that stays optional.

## Claim your alpha license

Open **Settings → License** and press **Claim alpha license**. Enter an email address to issue it to. That address is the only thing sent to Anjadhe, and it exists so the same key can be issued to you again: on another Mac, or after a reinstall, claim again with the same address and you get the same key back.

The result is a small signed key saved on this Mac. It keeps this Mac on every future release once the alpha closes and a trial period applies to new installs.

## Already have a key

**Settings → License** also takes a key directly: paste it into the box and press **Apply key**, or **Open file…** if it came as a file. The card then shows who it was issued to, when, and how long updates run.

## What a license does

A license names your class (alpha or paid) and decides which releases the updater may install: an alpha license gets every release; a paid license gets releases dated within its year of updates. **No feature is ever locked.** An install without a license, after the alpha closes and its trial ends, keeps working exactly as it is and simply stops being offered newer builds; the titlebar update pill then says so and opens Settings → License.

Verification happens on this Mac with a public key. Nothing is looked up online to check a license, and nothing about you is sent when it is verified.

## Removing a license

**Settings → License → Remove from this Mac** forgets the key on this Mac only. It is not revoked and nothing is sent; enter it again any time.`
        },
        'settings': {
            title: 'Settings reference — every section and where things live',
            description: 'Map of the Settings app: AI Assistant, Accounts, Appearance, Browser, Storage & Backup, Privacy & Security, Developer.',
            actions: ['setup-checklist', 'ai-models', 'accounts', 'appearance'],
            content: `Settings opens with Cmd+K (type "settings"). A search box at the top filters across every section. Sections:

## Set up Anjadhe
The guided setup checklist: connect Google (your inbox then turns into tasks automatically), enable web search, try the assistant.

## AI Assistant (Settings → AI Assistant)
The assistant's whole brain. The page is a list of rows, each showing a setting's current value; clicking a row opens that setting's own page:
- **Name** — give the assistant a name; it replaces the "AI Assistant" label across the app and the assistant answers to it. Blank keeps the generic label.
- **Your Models** — the model list with a default-model radio, grouped by where each model runs (On this Mac, Your server, Anjadhe Cloud, API providers), with a line under each heading saying where your data goes. Download local models (built-in llama.cpp engine), point at your own OpenAI-compatible server, add Anjadhe Cloud (free allowance, no key), or **+ Add model** with an OpenAI/Anthropic API key. Per-model Manage panel for keys and options; models that can view images carry a "Reads images" badge.
- **Web Search** — the **Enable web search** master switch, the Anjadhe Connect card (built in — plan, usage, Test), plus Tavily / Brave key cards for direct-to-provider searches.
- **Terminal Access** — turn on the local CLI bridge and install the \`anjadhe\` command for using the assistant from a terminal.
- **Tool Servers (MCP)** — connect external tool servers the assistant can use. Ready-made connections — Browser, DeepWiki, Context7, GitHub — add with one click and are tested on the spot.
- **Recipes** — procedures the assistant saved from tasks that finished cleanly; ask for one by name to replay it. Remove any here.
- **Assistant Permissions** — grants the assistant has been given (files, shell, servers); review or revoke.
- **Memories** — everything the assistant remembers about you; edit or delete.
- **Logs** — transparency logs of every AI call, web search, and network request from this machine.

## Accounts (Settings → Accounts)
Connect or disconnect Google (Gmail, Calendar) per account. Each Mac authorizes independently. **Email preferences** (insights, bundles, sender rules — shared by every account) has its own row here.

## Appearance
Theme (Light, Dark, or System to follow your Mac) and **More apps** — every app as a card with an enable switch (also the "More apps" row at the bottom of the sidebar). An app turned off keeps its data and can still be found by typing its name in Cmd+K; some apps (Portfolio, News, Wellness, Web Browser, AI Activity, Help, About) start off and are enabled here. Packaged apps (Wellness, Pomodoro, Portfolio, Bookmarks, News) also have an **Uninstall** action: an uninstalled app is not loaded at all (no page, home card, search results or assistant tools), its data stays on the Mac, and it comes back with **Install** from the same page after a reload.

## Browser
Default search engine for the built-in browser (DuckDuckGo, Google, Bing, Kagi, Brave).

## Storage & Backup
Database location, disk usage, backups, **Sync Between Macs**, and **Sync Encryption** — set a passphrase that protects the multi-Mac sync key end-to-end.

## Privacy & Security
- **Lock Anjadhe** — require Touch ID to open the app.
- **App Lock** — pick specific apps that need Touch ID / passcode to open (Notes, Journal…).
- **Network logs** — every outbound connection this app made.
- **Usage signals** — anonymous, off by default.

## Developer
- **Build apps** — turn on the ~/Anjadhe/apps/ folder for coding-agent-built apps. Each installed app is listed with a **Reset Data** button that clears that app's saved data alone (the app stays installed; the reset syncs to other Macs).
- **Developer Tools** — inspect/debug (Chrome DevTools).`
        }
    },

    /** Compact index — slugs with one-liners, for an invalid/omitted topic. */
    index() {
        return Object.entries(this.docs).map(([slug, d]) => ({
            topic: slug, title: d.title, about: d.description
        }));
    },

    get(topic) {
        const doc = this.docs[topic];
        if (!doc) return null;
        const out = { topic, title: doc.title, content: doc.content };
        // Doors this doc sends people to, as ids the caller resolves
        // against HelpActions. Filtered there (a gated destination drops
        // out), so an empty result is normal and simply means no buttons.
        if (Array.isArray(doc.actions) && doc.actions.length) out.actions = doc.actions.slice();
        return out;
    },

    slugs() {
        return Object.keys(this.docs);
    }
};
