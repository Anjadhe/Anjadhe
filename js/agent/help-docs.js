/**
 * HelpDocs — the assistant's built-in knowledge of nenva itself.
 *
 * This is the ONLY help nenva has (2026-10-07): the in-app Help page, the
 * per-page "?" buttons and the website's help articles were all removed —
 * the assistant is the helper, and this is what it reads. Nobody else sees
 * these words, so they are written for the model: exact Settings paths,
 * what each thing does. When a feature or a Settings path changes, update
 * the doc here; RELEASING.md has a per-release review step for this file.
 *
 * Served to the model one doc at a time via the get_help tool
 * (agent-tools.js, tool group 'help') — deliberately NOT injected into the
 * system prompt: the whole corpus is thousands of tokens and prompt-eval
 * dominates latency on local models.
 *
 * Style: plain markdown, bold **Settings → …** paths so answers can cite
 * exact locations, no HTML, no emojis. Keep each doc under ~500 words —
 * these land in a 12B model's context as tool results.
 *
 * Each doc also declares `actions` — ids from HelpActions (help-actions.js)
 * naming the pages it sends people to. Those become the buttons under the
 * assistant's answer, so "open Settings → Connectors" is a click rather than
 * a scavenger hunt. Keep the list SHORT (2-4) and ordered by what the doc
 * is mostly about; the button row is capped and a doc that offers eight
 * doors offers none. When a doc's Settings path changes, the action id
 * changes with it.
 */
const HelpDocs = {
    docs: {
        'getting-started': {
            title: 'Getting started with nenva',
            description: 'First steps: the Now page, commitments in plain words, connecting Gmail/Calendar, choosing where the AI runs.',
            actions: ['connect-google', 'ai-models', 'goals'],
            content: `## Your Now page

**Now** is where your assistant walks you through what needs you, **one card at a time**. Each card shows where it came from (an email, a text, your calendar, your tasks, a routine) as a small icon, and it holds still while you are looking: move through the deck with the **‹ ›** buttons beside the count.

- **Tap a card's title** to open its page (the email's item on Insights, the task, the trip). **The main button** does the obvious thing (Reply, Pay, Mark done, Schedule 2 sessions…).
- **Tell me what to do with this…** — click the box in the card and you are in that thing's own chat, cursor ready, with everything said about it before. One chat per thing, wherever you reach it from; the card shows its last exchange.
- **Ignore** lets an item go quietly (an invitation you are not going to); Undo brings it back.
- **A quick question** card asks a preference with one tap (keep writing the market brief? use this reminder for new tasks?). Your answer goes to **Memory → Preferences** as a sentence you can change with a tap.
- **Work planned back from a due date** — for something due in the next two weeks that needs time (a project packet, a form to gather), nenva proposes work sessions in your free time; **Schedule N sessions** adds them, **Pick other times** talks it over.

## Say what you will do

There is no task form. Tell the assistant in any chat, or type into the box on the **Commitments** page (**Memory → Commitments**): "Call the dentist tomorrow at 3", "Run every Mon Wed Sat at 7am", "Ship v1 by the end of June". A commitment is anything you said you would do; a big one (an outcome, what used to be a project) holds smaller ones. The assistant keeps the dates and the repeats, proposes a change when your words point at something you already have, asks how it went after the time has passed, and files what you tell it on the right day. Every change it makes shows a receipt with **Undo**.

Good commitments are specific and finishable — "Run a 10K on October 18", "Save a 6-month emergency fund by December" — not "get healthier", which you can never check off. Today's commitments and the next seven days are on **Now** under **Today** and **Coming up**.

## Connect your tools

- **Gmail** — nenva reads your mail to find what needs you: bills, appointments, renewals, replies. Each becomes one item with its next step; you read and answer the mail itself in Gmail.
- **Google Calendar** — today's meetings and the week ahead on Now, and the assistant can add, move or delete events.

Open **Settings → Connectors** to connect; each source has a small page of its own there, and can be turned off any time.

## Choose where the AI runs

A new install starts on **nenva cloud lite**: an open-weight model hosted by nenva, with a free monthly allowance and no account or key. What the AI works on goes to nenva's server and on to its inference provider under a no-retention agreement; your data itself stays on this Mac. To keep the AI on this Mac too, open **Settings → Model** and download a local model (offered on Macs with 8 GB or more, sized to the machine), then choose it. Choosing it while it is still downloading is fine: your current model keeps answering, and nenva switches when the download finishes. The same page adds your own OpenAI-compatible server or an OpenAI/Anthropic model with your own API key. Nothing ever falls back to a destination you didn't pick.

Everything else — Text Documents, Documents, Finance — is optional; use only the parts that fit. Press **Cmd+K** and type a name to open any of them.`
        },

        'your-day': {
            title: 'Your day — Now, Commitments & Insights',
            description: 'The Now page (Today, Coming up, one card at a time), the Commitments page (everything you said you would do, in plain words: repeats, one day moved, how it went, Undo), and Insights (every item found in mail and texts, incl. bookings and trips).',
            actions: ['tasks', 'email-insights', 'memories'],
            content: `**Now** is the day: what needs you, one card at a time, then **Today** and **Coming up** (the next seven days) joined from your commitments and your calendars. **Commitments** is the whole list of what you said you would do. **Insights** is every item nenva found in your mail and texts. There are no Tasks, Projects or Calendar pages any more (since 2026-10-05): a task is a commitment, a project is a big commitment with smaller ones under it, and the calendars are read onto Now.

## Commitments — what you said you would do

Open it from **Memory → Commitments** (or ask the assistant to). The page is one line of counts, a box, and the list in sections: **Today**, **Moving** (the big ones with their next step), **Waiting on others**, **Later**, and **Done**, folded. No date buckets, groups, colours or tags to maintain.

**The box.** Type in plain words — "Call dentist tomorrow 3pm", "Water plants every tuesday", "Pay rent monthly", "Run a 10K on October 18" — and the assistant shows what it understood as facts before anything is added. Words about something you already have come back as a proposed change to it ("move the dentist to Friday"); a question opens that thing's chat over the page.

**The sheet.** Open a commitment and its facts are chips you tap to change (the day, the time, the repeat, who it is waiting on), with its steps, a note, and **Done**, and under the sheet **Ignore**, **Add a note** and **Delete**. The box at the bottom opens the commitment's own chat, with everything said about it before. **Attach** links what it is about: find a file or text document by name, paste a link (a Notion page, a form), upload a new file into Documents, or drop files on the sheet. The assistant can attach these too, including a file you sent it in a chat, and reads them when you ask about the commitment.

**Repeats.** A repeating commitment comes back on its days (daily, weekdays, weekly days, monthly, yearly). Checking one off completes it for that day; tomorrow it returns. "I'll do the workout this evening, just for today" moves that day only — the usual time stays, and the reminder rings again at the new time.

**How it went.** A couple of hours after a commitment's time, nenva may ask how it went — only for the ones worth asking after, and never about a day you already marked or wrote about. "Not done yet, I'll do it later today" is kept as a plan, not a report, and the question waits for the evening. What you say about a day in the commitment's chat is filed on that day.

**Undo.** Every change — yours or the assistant's — shows a receipt with Undo. The assistant asks before it writes, and a reply that claims something was changed is checked against the record before you see it.

## Now — one card at a time

Each card comes from a real record (an email item, a text, a calendar event, a commitment, a routine) and shows where it came from; move through the deck with **‹ ›**. **Tap the title** to open the thing; **the main button** does the obvious thing (Reply, Pay, Mark done, Schedule sessions…); **Ignore** lets it go quietly, with Undo; the box in the card opens that thing's own chat. **Today** lists each commitment and meeting with one line of help and one action; **Coming up** is the week ahead.

## Insights — what your mail and texts said

Every item nenva found in your email (and, when **Settings → Connectors → Apple Messages** is on, your texts): bills, receipts, renewals, appointments, reservations, deliveries and deadlines, one card each, with **Needs you** at the top and **Done** folded underneath. A card opens in place with the facts pulled out of the message (a flight's route and times, a booking code, an amount, who it is from), what to do about it, and **Open in Gmail**, **Add task** and **Done**. Opening a card does not mark it done. Messages about the same thing — an office's email and its text, the reminder and the confirmation — are kept in one folder with one next step, and bookings that belong to one trip are gathered into the trip. Items stay for **90 days**, so a hotel booked in June is still there the morning of the trip. Marketing is not an insight. Now opens an item or a trip there; the Insights page itself is reached from a card.`
        },

        'the-assistant': {
            title: 'The assistant',
            description: 'What the AI assistant can do, memory, sources, long tasks and routines.',
            actions: ['ai-models', 'memories', 'routines'],
            content: `## What it does

The assistant is one chat that can: answer about your life (commitments, text documents, your Documents, email insights, calendar, money), do things for you (add and change commitments, write text documents, file what your mail says, search the web, read pages, and — if enabled in **Settings → Advanced → Permissions** — work with files), and answer anything general. Start one with **New chat**; every chat you have had is on the **Chats** page.

**Private by design.** The model runs on this Mac by default, on a server you own, on OpenAI or Anthropic if you added your own API key, or on nenva cloud if you chose it. Conversations and personal data go only to the brain you picked. Pick the model in **Settings → Model**.

**It knows nenva, and it can take you there.** Ask how something works, where a setting lives, or what is left to set up ("am I connected?", "what should I do first?") and it answers from the built-in guide plus what this Mac actually has — connected accounts, the model in use, whether web search is on. Answers that point at a page carry buttons straight to it, so "connect Gmail" is a click rather than a hunt through Settings. The buttons only ever navigate: the page they open is where you decide.

**Name it.** You can give the assistant a name: first-run setup asks, and the **Name** field at the top of **Settings → Advanced → Name** works anytime. The name replaces the "AI Assistant" label across the app, and the assistant knows it and answers to it. Clear the field to go back to the generic label; the name syncs to your other Macs.

**Sources.** When an answer used the web, a Sources row under it lists what was searched and every page actually opened — recorded from what the assistant really did.

**Memory.** nenva remembers lasting things you tell it in chat (who you are, the people in your life, your work, how you like things done, your plans) as short facts in your own terms, each kept only if you actually said it. A quiet "Remembered: …" line appears under any reply that saved one, with **Undo** right there. **Memory** (in the left nav) lists everything under five headings: About you, People, Work, Preferences and Plans. Click a fact to fix it, hover to star it (starred facts go into every chat) or forget it, or type your own at the top. About you and Preferences ride into every chat; the rest the assistant looks up when a question needs it. A fact not mentioned in six months shows under **Needs a look** so you can keep or remove it. You can also just say it in chat: "remember that…", "that's wrong, it's X", "forget that". Memory stays on this Mac; noting facts runs on the model you've chosen.

**Private chats.** Click **Private** in the AI Assistant header (or **Start a private chat** in the ⋯ menu of the docked panel) for a chat the assistant won't remember. A private chat isn't saved to your chat history or synced to your other Macs, nothing from it goes into memory, and nenva's own logs record only that a request happened, not what it said. It ends when you leave it: **End**, a new conversation, or opening another chat closes it for good, and so does reloading or quitting the app, which asks first. The banner above the chat has a **Use my personal info** checkbox. It starts off, so the assistant answers from general knowledge and the web only. Tick it to let the assistant read your commitments, documents, calendar, memory and other apps for this chat (it still remembers nothing). Things you ask it to *do* in a private chat, like creating a task or sending an email, still happen and stay done. Private is about remembering, not about where the words go: they still go to the model you picked, so with a cloud model they reach that provider as usual.

**Decisions.** A decision is a dated instruction pinned to one specific record — a strategy's "invest $2,000 monthly through October", a task's "never move this past Friday". When one gets settled in chat, the assistant asks before saving it (a "Noted on …" line confirms it), and from then on it re-reads that decision every time it works with the record, in any conversation. A record's page shows its decisions — a strategy, a Finance account, a routine — where you can add one by hand or delete one.

**Mention a record with @.** Type @ in any assistant message box to pull up your commitments, text documents, routines, strategies and accounts; keep typing to narrow, or make the first word a type ("@project marathon"). Picking one inserts its name and attaches the conversation to that record — the assistant sees its current state and its decisions from then on. A banner above the chat names the attachment, with an ✕ to detach.

**Attachments.** The + button on the message box (or drag and drop) attaches text files, CSVs, PDFs — and images, if the model can read them. Vision-capable models carry a "Reads images" badge on their card in **Settings → Advanced → Model options** (most OpenAI and Anthropic models qualify; a nenva local model that reads images needs its vision file downloaded). On a model that can't view images, nenva says so at attach time.

**Seeing and using the app.** Ask the assistant to look at the screen ("what do you see?") or to do something in the app itself ("open Settings and turn on dark mode", "click Save"). It takes a screenshot of nenva's own window, numbers every button and field on it, and works one step at a time: click, type, press a key, or scroll, looking again after each step. With a model that can read images it sees the screenshot itself; with any other model it reads the screen as text (the page's words and a list of its buttons and fields). Every action asks you first, like other actions that change things — pick "for the rest of this session" to let a longer job run. It only works inside nenva's window (not other Mac apps), never in background routines, and it can never click its own chat or answer its own permission prompts. After it has looked at an email or a web page in a chat, every action asks again, whatever you allowed before.

**Documents.** The assistant also opens documents it reaches itself — a PDF (scanned ones are read on this Mac), an Excel spreadsheet, a Word document, or an image, in a folder it has access to, on a web page, or attached to an email. On a model that can view images, an email's inline pictures and image attachments are read along with the email. It reads the contents rather than guessing from the filename, so "what did this statement charge me?" is answered from the statement.

**Routines — working while you are away.** Ask for something on a schedule ("every weekday at 7, check my portfolio against the news") or when something happens (an email arrives from a certain sender, with certain words in the subject, or mentioning something anywhere in the message — "an email with an invoice in it"; or a file lands in a folder) and the assistant offers to set it up as a routine. You approve it once — that approval is what lets it run with nobody watching — and from then on it runs by itself on this Mac. A routine either **writes you an answer** (it can read, never change anything, and each answer lands in the routine's own chat, with the newest one on **Now**) or **takes actions**, which can change your data. The one you are approving is named in the confirmation. An action routine does not write into its chat — each run's log is kept on the routine's own page under **Run history**, and a run that fails also shows there as the routine's last problem. A routine that takes actions pauses and notifies you if a step needs permission, rather than guessing. Your routines are listed under **Standing** on the **Chats** page, each with what triggers it, when it last ran, a dot for an answer you have not opened, and anything **waiting on you**; open one for its run history, and **Edit** opens its chat, where every answer it wrote is kept (the last ten) and you can reply to any of them. Standing permissions — grants that let the assistant act without asking, each with optional limits (uses per day, an end date, exceptions such as "known email recipients only") and one-tap revoke — live in **Settings → Advanced → Permissions**. When a limit runs out, the assistant asks instead of acting.


**Undo.** Everything the assistant changes in your data or files is recorded. **Undo this turn** under a chat answer puts things back. Anything you edited yourself in the meantime is skipped and reported, never overwritten. Actions that cannot be undone from here (a sent email, a calendar invite) are marked as such when you approve them.

**Big jobs go to the team.** Ask for something big ("research all of these and build me a table", "plan my workouts for the month and add them") and the assistant hands it to its team: nenva brings in specialists one at a time (mail, calendar, tasks, notes, documents, web research, a browser, a writer). The job starts right away and works in the background; a line under the reply shows who is doing what, with **Stop** and **See the job**, and the answer is posted into the chat when it is done. The team can add and change commitments, calendar events and text documents, and every change asks you first with an approval card in the chat (**This session** or **Always** stops it asking for that kind of change). It never deletes or sends anything. A job's status rides its chat's row on the **Chats** page; the job itself opens from the chat.

${typeof FEATURES !== 'undefined' && FEATURES.isEnabled('teach') ? `**Teach it a website task by showing it once.** Say "let me show you how I get the kids' assignments" (or the bank statement, the water bill) and nenva opens its own Chrome window in front of you. Do the task the way you always do, sign in if the site asks, then press **Done** in the window. nenva writes down what it saw as a note in plain words, shows it to you to confirm, and keeps it under **Memory → Taught tasks**, where you can rewrite it any time. From then on, ask for the task by name ("get the Schoology assignments") or say "do this every Sunday" for a routine. nenva follows the note with judgment, not click by click, and hands the window to you when a site wants a sign-in or a code. Passwords, codes and card numbers are never recorded. Nothing about a recording leaves this Mac.

` : ''}## Routines

A **routine** is a prompt that runs on a schedule (hourly, every 6h, daily, weekdays, or weekly, optionally at a set time like 8:00 AM) or when something happens, in the background on the model you chose. One that writes answers posts each result into the routine's own chat (the last ten are kept); one that **takes actions** keeps each run's log on its page under Run history instead. Your routines are listed under **Standing** on the **Chats** page, each with when it runs and its last run; open one to read its results and run history. To set one up, ask the assistant in chat — "every morning, give me a list of Staff+ engineering jobs" — and it tries the routine once and shows you the result before you approve it. Not sure what to automate? **Set up a routine** on the Chats page starts a short guided chat: the assistant asks one question at a time (what it should do, when it runs, whether it writes answers or takes actions) and builds the routine with you. To change one, open it and choose **Edit**: that opens its chat, and you say what should be different. Per-routine options: use personal context, allow web search, or plain offline generation. A new install arms no routines on its own. A result worth your attention shows as a card on Now; links inside results (and chat, text documents) open in your own web browser, where you are already signed in.`
        },

        'ai-models': {
            title: 'Choosing where the AI runs — local, your server, your own API key, or nenva cloud',
            description: 'The four homes for the model, switching the default model, adding an OpenAI/Anthropic key or nenva cloud, pointing one part of the app at a different model, when a cloud model makes sense.',
            actions: ['ai-models'],
            content: `## Four homes for the brain

Every AI feature — chat, email insights, the money coach, routines — runs on the model you picked. **Settings → Model** is the one place: one model for everything (choosing there also clears any per-part assignment an earlier version made). Per-model keys and options are under **Settings → Advanced → Model options**. The model can live in four places:

1. **This Mac — nenva local.** An open-weight model that runs on this Mac through the built-in llama.cpp engine. Free, offline, nothing leaves the machine. Offered on Macs with 8 GB of memory or more, sized to the machine: on an 8-16 GB Mac, nenva's own small model, tuned for email insights and the assistant's tools (light and fast); larger models from 32 GB up. Every size is called nenva local; the download list tells them apart by size, the memory each needs and whether it reads images. The smaller the model, the simpler the tasks it handles well — nenva cloud is the stronger option for a small Mac.
2. **A server you own.** Any OpenAI-compatible endpoint you host — llama-server, vLLM, LM Studio on a homelab box.
3. **A provider you trust, with your own key.** The official OpenAI or Anthropic API, added as a model entry with a key from your own account. Frontier capability, at the cost of sending what runs on that model to the provider.
4. **nenva cloud (the default for a new install).** Open-weight models hosted by nenva, in two tiers: **nenva cloud lite** is fast and handles everyday questions and background work; **nenva cloud pro** is a bigger model for harder questions. No account, no key, a free monthly allowance of AI requests. What runs on it goes to nenva's server (api.nenva.co), which forwards it to a zero-data-retention inference provider, without your identity; the service keeps usage counts, never what you asked, and its source code is public so that can be checked.

nenva cloud is where a new install starts; every other off-Mac option is an explicit choice, and nothing ever falls back to a provider you didn't add.

nenva's own models are named by tier — nenva cloud lite, nenva cloud pro, nenva local — and keep their names as the models underneath improve. A server you own and an OpenAI or Anthropic model you added show their real names.

## Adding a cloud model

1. **Settings → Model** → **Add a model** (or **Settings → Advanced → Model options** for per-model keys and options). The page lists the homes
   on the left — **On this Mac** first when this Mac can run one, **nenva
   cloud** first on a Mac too small for any local model.
2. Pick **nenva cloud**, **OpenAI API**, or **Anthropic API**.
3. nenva cloud needs no key — pick **nenva cloud lite** or **nenva cloud pro** (each shows a short description of what it's good at) and click **Add**; you can add several and switch between them. For OpenAI/Anthropic, paste an API key from your account (platform.openai.com/api-keys or console.anthropic.com/settings/keys), click **List models** to fetch the live list your key can use, and pick one.
4. **Test** if you like, then **Add model**.

Make it the default via the radio on its card. You can keep local and cloud models side by side and switch from the model chip in the chat box. Keys are stored encrypted on this Mac, per model, and never sync — each Mac needs its own copy. The nenva cloud card's **Manage** panel shows how much of the monthly allowance is used.

## Pointing one part of the app at a different model

Everything runs on your default model: chat, email insights, routines, documents, money. There is one model to choose, in **Settings → Model**. (A per-part assignment made before 2026-10-06 is still honoured; "Use this model for everything" on the Model page clears it.)

Chat itself isn't in that list: it runs on whichever model is marked **Default** in the list above, which is also what the model chip in the chat box switches. Every row left on **Follows the default model** moves with it, so the list only holds what you deliberately sent elsewhere.

Two things worth knowing:

- **This Mac runs one local model at a time.** A second local model is offered only in place of the first — switching between two of them would reload gigabytes of weights on every request.
- **Work sent to a model off this Mac runs beside your chat** instead of waiting in line behind it, because it isn't competing for this Mac's memory. That's the one way to make nenva do two things at once.

Choose where your AI runs in **Settings → Model**, with no fallback across engines. **Settings → Advanced → Developer → Data activity** shows recent requests sent to online services, by date, service and kind.

## When a cloud model makes sense

On an 8–16 GB Mac the local models on offer are small and fast, and they handle everyday tasks — for harder work (long documents, multi-step tasks), nenva cloud is the no-setup upgrade, with a free monthly allowance — when it runs out, requests pause until the 1st. With your own key, be clear-eyed: what you run on that model goes to that provider under your account and their data terms, and usage is billed by the provider to you — nenva adds nothing on top.`
        },

        'cloud-privacy': {
            title: 'Cloud privacy — what leaves this Mac when the AI runs elsewhere',
            description: 'What nenva cloud (or your own key/server) receives, what is stored, what background work may send, the "Data activity" list, and how to check the server code.',
            actions: ['cloud-privacy', 'ai-logs', 'ai-models'],
            content: `## When the model runs off this Mac

With a local model nothing you do leaves the machine. When your default model is nenva cloud, your own OpenAI/Anthropic key or a server you run, every prompt goes there — the model has to read the text to answer. nenva keeps that honest in four ways.

## 1. Chat sends what you typed; background work sends only what you allow

What you ask in chat goes to the model exactly as you typed it, with the context you attached. nenva also does work without being asked: email insights, routines, the money coach's looks. **Settings → Model** shows where your AI runs. Background work may send what you connected to the model you chose, with one exception you decide at connect time: **your texts** stay on this Mac unless you allow the AI to read them on the Apple Messages connector page. **Messages is off by default.** A switched-off kind stays on this Mac: the insight sweep pauses, a routine that tries to read it is told why, and **Settings → Advanced → Developer → Data activity** shows a "kept on this Mac" line so nothing is skipped silently. Asking about that data in chat still works. The switches sync between your Macs; they take effect the moment you pick a model that runs elsewhere.

## 2. Every request that left is listed

**Settings → Advanced → Developer → Data activity** lists every call that went to a server: when, where to, what kind of thing it was about. The developer's view (**Settings → Advanced → Developer → LLM Logs**, filter **Left this Mac**) shows each request with the exact messages it carried and the reply. The list is built from the same object the app sent, so it cannot differ from what went out. The model chip in the composer carries a small arrow whenever the model runs off this Mac.

## 3. Less goes than you might think

Before an email body leaves for background analysis, quoted history, signatures and tracking links are stripped, and background prompts are capped in size. nenva cloud requests carry no account, name or email address — only a per-install key.

## 4. The server is checkable, not just described

nenva cloud runs on nenva Connect (api.nenva.co), whose code is public. Prompts and answers are never logged or stored; a test in that code sends marked text through every path and fails if it shows up in a log line, an error body or the database. What is stored: request and token counts per install per month, keyed by a hash, deleted after 400 days. The nenva cloud card in **Settings → Advanced → Model options** shows the commit the server is running so you can compare it with the public repository. Requests go on to a zero-data-retention inference provider; the provider sees nenva's server, never you. Any change to what is stored is announced at least 30 days ahead.`
        },
        'web-search': {
            title: 'Web search — opt-in, private by design',
            description: 'Web search is off until enabled (setup or Settings); nenva Connect, what leaves the Mac, switching to your own key, search logs.',
            actions: ['web-search'],
            content: `## Off until you turn it on

Web search is an explicit opt-in: the first time the assistant wants to search, it asks with the exact query on screen — approving that first search turns web search on — and the **Enable web search** switch at the top of **Settings → Advanced → Web Search** turns it on or off anytime. When it is off, nothing in nenva sends queries to the web — the assistant answers from the model alone, and routines work from local data only. When enabled, the built-in option is **nenva Connect** (api.nenva.co), a small relay nenva runs, which forwards the query to a search provider and returns the results. 300 searches a month are included — no account, no key to paste.

## What the relay sees — and what it keeps

A web search means the query leaves this Mac; the relay is built so that is ALL that happens:

- It stores a **count** of searches per installation — not the queries. Nothing you search is logged or kept.
- The search provider on the other side sees queries arriving from nenva's server, mixed in with everyone else's — not your name, account, or address.
- The relay's source code is public, so this can be checked rather than believed.

Documents, email, and notes never ride along — only the query itself.

## Prefer nenva out of the loop? Use your own key

The **Tavily** and **Brave Search** cards (Settings → Advanced → Web Search) send searches straight from this Mac to that provider — no nenva relay involved. Create a free account (Tavily includes 1,000 searches a month, no credit card), paste the key on the card, **Save Key**, then **Test**. Keys are stored encrypted on this Mac and never sync — paste the key on each Mac you use.

## Check what left this machine

A Sources row under web-assisted answers lists what was searched and every page opened, and **Settings → Advanced → Web Search Logs** records every query that left this Mac — whichever provider handled it.`
        },

        'connected-accounts': {
            title: `Connectors — Email, Calendar, Apple apps, texts, ${(typeof FEATURES !== 'undefined' && FEATURES.isEnabled('slack')) ? 'Slack, ' : ''}Notion & Linear`,
            description: 'Settings → Connectors: connecting Gmail and Google Calendar, email insights, the calendars on Now, Apple Reminders (two-way), Apple Notes (index only) and Apple Calendar, reading and sending texts, ' + ((typeof FEATURES !== 'undefined' && FEATURES.isEnabled('slack')) ? 'Slack conversations, ' : '') + 'Notion pages, and Linear issues and projects on request. Use get_setup_status for this Mac’s live connections.',
            actions: ['connect-google', 'accounts', 'email-insights'],
            content: `## Email insights

Connect Gmail in **Settings → Connectors** (one searchable list of every outside source nenva reads, each with a small page of its own). Mail syncs from Google's servers straight to this Mac, with no service in the middle, and nenva reads it to find what needs you. You read and answer the mail itself in Gmail: every **Open in Gmail** button opens that exact message there.

- **Right after you connect**, Now says "Reading your email · 37 to go". The first read covers the last two weeks and takes a few minutes; cards wait until it is done instead of coming and going.
- **Insights** are short summaries of what matters: bills, receipts, renewals, reservations, deadlines. Click one (a card on Now, or on the Insights page) to see the amount, dates and what to do, with Open in Gmail, Add task and Done. Opening one does not mark it done; Done does. Marking one "not useful" teaches it: enough votes stop that kind of insight from that sender. Insights that need action from you always come through, and only Mute silences a sender. Email preferences live in Memory › Email; tell nenva in chat what to show or skip.
- **One folder per real thing**: every message about the same appointment, bill, order, booking or subscription is kept together, with one next step; that step becomes a commitment when it is real work, linked back to the email. Nothing is ever sent or paid from here.
- **Asking about mail**: the assistant searches the mail synced to this Mac ("anything from the landlord this month?") and can pull older mail from Gmail once you confirm how far back to go.

Each Mac syncs mail independently (Gmail is the source of truth), and analysis happens on your own model.

You can still ask nenva to search and read email, read attachments, draft replies, and send email through your connected Gmail account. Review and revise drafts in chat; sending uses the usual approval flow. Prepared follow-up drafts open in chat too. There is no in-app Inbox or email composer.

## Calendar

There is no calendar page in nenva (since 2026-10-05). Your Google Calendar (Settings → Connectors) and, on this Mac, your Apple calendars are read for **Now**: today's meetings under Today and the next seven days under Coming up. Ask the assistant to list, add, move or delete events ("move my 3pm to Thursday"); it does the arithmetic and asks before any change. An event opens where it lives — Google Calendar's own page, or the event in Calendar.app for an Apple one.

## Apple Reminders, Notes & Calendar

**Settings → Connectors** lists this Mac's own Apple apps — no Apple ID or password involved, just a one-time macOS permission prompt. Each is a separate switch with its own page:

- **Apple Reminders** — every open reminder becomes a commitment, with its due date, time, and repeat (daily, weekly, monthly, yearly); a list picker chooses which lists to read. It works both ways: completing a reminder in Apple Reminders marks it done here on the next read, and marking it done, changing its title or day, or deleting it in nenva writes back to Apple Reminders (Undo writes back too).
- **Apple Notes** — read for the index only: the assistant can search and read your notes (answers name the source), but nothing is copied into nenva and there is no notes list here. Locked notes are skipped. **Read again now** on its page re-reads them.
- **Apple Calendar** — events from this Mac's iCloud and local calendars appear on Now beside your Google ones. The assistant can create, update and delete Apple events (say which calendar, or "apple" when there is one), with the same this-event / all-events choice for a series; calendars that refuse edits (subscribed, holidays, shared read-only) are read only. Google-account calendars in the Mac's Calendar app are deliberately left out — nenva syncs Google Calendar itself.

Reminders and Notes are read when the app opens, plus a button on each page to read again now; the Calendar mirror refreshes on its own every few minutes and when the window comes to the front, so an event added in Calendar.app shows up without a relaunch. **Turning a switch off removes what it brought in** (everything stays in the Apple app; turning it back on brings it all back).

## Telegram

Chatting with this Mac's assistant from the Telegram app has its own guide: ask for the **telegram** help topic. It is set up on **Settings → On your phone** (the older card is still under Settings → Advanced → Telegram).

${typeof FEATURES !== 'undefined' && FEATURES.isEnabled('slack') ? `## Slack

Open **Settings → Connectors → Slack**, click **Connect Slack**, then **Continue to Slack** to sign in and choose your workspace. Ask nenva to find a conversation, catch up on a thread, or send a message. Requested content goes to your selected AI model; actions follow your approval settings. Credentials stay on this Mac. **Disconnect** removes this Mac's access; you can also revoke access in Slack.

For “is Slack connected?”, call **get_setup_status** and check **toolServers** for Slack. Google accounts are separate, and this guide does not report your live connection state. A connected Slack account works on demand even when monitoring is off. Optional watching is one row on the same page once Slack is connected: **Keep an eye on Slack** › **Choose conversations** picks up to 20 people and channels (it reads with your own model unless you change it), after which nenva watches them for requests that need you, commitments and changed decisions, and files what it finds with your mail and texts. **Pause**, **Stop watching** and **Add a morning review** are on that page too. Signing in alone starts no monitoring or routines.

` : ''}## Linear

Open **Settings → Connectors → Linear**, click **Connect Linear**, then **Continue to Linear** to sign in and choose your workspace. The return address **127.0.0.1** means your own Mac; sign-in connects directly to Linear. Ask nenva to find issues, summarize projects, or create and update issues and comments. Requested content is shared with your selected AI model, and actions follow your saved approval settings. Connecting does not grant automatic approval to tools. There is no background workspace import. **Cancel sign-in** stops a pending connection; **Disconnect** removes this Mac's credentials and access. You can separately revoke authorization in Linear. No API key or Node.js install is needed.

## Notion

Open **Settings → Connectors → Notion**, click **Connect Notion**, then **Continue to Notion** to sign in and choose your workspace. The return address **127.0.0.1** means your own Mac; sign-in connects directly to Notion. Ask nenva to find, read or update pages and databases. Pages stay in Notion, and requested content is shared with your selected AI model; actions follow your saved approval settings. **Disconnect** removes this Mac's credentials and access. You can separately revoke authorization in Notion.

## Linked institutions

**Settings → Connectors → Linked institutions** manages brokerages, banks and credit cards linked through Plaid. Link an institution, sync its accounts, sign in again or unlink it here. Institution linking is under development and is hidden until nenva enables it for release. Holdings and transactions pass through nenva cloud on their way to this Mac; the connection page explains this before you link.

## iMessage

**Settings → Connectors → Apple Messages** lets you save your own iMessage number or email for texts you ask the assistant to send to “me”. Messages on this Mac must be signed in to iMessage; the first send asks macOS for permission to let nenva control Messages.

**Texts** in **Settings → Connectors** reads the texts that arrive in Messages on this Mac the way Insights reads your mail: each conversation is read once it goes quiet, and appointment reminders, deliveries, bills, codes and plans made over text land in Insights beside what your mail said, in the same folder when they are about the same thing; anything that needs doing becomes a commitment. It needs **Full Disk Access**, and you have to give it by hand — macOS does not put nenva in that list on its own, so do not look for a switch that is not there yet. Open System Settings → Privacy & Security → Full Disk Access, click the **+** button under the list, pick nenva from your Applications folder (it is still called Anjadhe there if this Mac updated from it), and make sure its switch is on. Then quit nenva, open it again, and press **Check now** on the Texts page. The first read covers the **last 30 days** of texts, grouped by conversation (one conversation counts as one item, and a chat with only your own texts is skipped), so the count is smaller than your Messages list; from then on new texts are read as they arrive. That permission covers the whole Messages database, which is why the switch is off until you turn it on. Your texts go only to the model you chose; with a cloud brain they stay on this Mac unless Cloud Privacy (see the cloud-privacy topic) allows Messages. Turn it on for ONE Mac. Turning it off forgets the conversations it read; commitments stay. The assistant still does not answer texts — use Telegram or the nenva phone app to chat with it from your phone.

**The assistant can send texts.** Once your number is saved on the Texts page, ask it in chat: "text Priya that I'm running late", "send myself a reminder by iMessage", "text +1 555 0100 the address". It sends through the Messages app on this Mac, and it shows you the recipient and the exact wording first — every text to another person asks for your OK, and a standing permission (Settings → Advanced → Permissions) can only ever cover texts to your own number. It knows your own number from the Texts page, and a person's name from conversations Texts has read; otherwise give it the number. If you just say "send a message", it asks whether you mean a text or an email rather than guessing.`
        },

        'telegram': {
            title: 'Telegram — chat with this Mac\'s assistant from your phone',
            description: 'Setting up Telegram on Settings → On your phone: make your own bot with @BotFather, paste its token, link your phone by pressing Start; the two switches (You reach nenva / nenva reaches you), what nenva sends unprompted (new cards on Now, commitments with a time, approvals with Allow / Not now), one-Mac rule, privacy, unlinking and disconnecting.',
            actions: ['telegram', 'accounts'],
            content: `## What it is

**Settings → On your phone** lets you message the assistant that runs on this Mac from the Telegram app, and lets nenva reach you there when something needs you. You bring your own bot, so nothing is shared with anyone else's: your messages go from Telegram to this Mac, run on your own AI model with the assistant's tools, and the reply comes back in the same chat.

## Set it up

The page walks through three steps:

1. **Make your bot.** Press **Open BotFather** (or scan its QR code with your phone). Send BotFather the words the page shows, one at a time (each has a copy button). BotFather answers with a **token**, a long string with a colon in it. Copy it.
2. **Paste the token.** Press **Paste** (or paste it into the field). nenva connects by itself and gives the bot nenva's description.
3. **Link your phone.** Scan the QR code with your phone, or press **Open the chat in Telegram**, then press **Start** in Telegram. That chat becomes the one this Mac answers, exactly one chat. If Start does not link it, send the six-digit code the page shows. Linking from this page also turns on **nenva reaches you**, and the step says so first.

Set this up on **one Mac only**. Telegram allows a single listening app per bot, so a second Mac connected to the same bot would take the messages away from the first.

## The two switches

- **You reach nenva**: messages you send the bot are answered. Off, they are not received.
- **nenva reaches you**: nenva messages you, unprompted, for three things only: a card that is new on Now (once each, never the backlog, at most ten a day), a commitment you gave a time, and anything waiting for your approval. The assistant writes each message from the facts. Other notifications stay on the Mac.

## What the assistant can do from Telegram

The same assistant as on the Mac, with its tools: it can read your data and answer about it, and add tasks or notes. Something that needs your approval (deleting, sending, spending) comes with **Allow** and **Not now** buttons under the exact action; answer on the phone or the Mac, and the first answer settles it. Message text is never written to this Mac's logs.

## Privacy

Messages and replies travel through Telegram's servers, like any Telegram message. The bot token is stored encrypted on this Mac. Only the linked chat is answered; a message from any other chat is ignored.

## Changing or removing it

- **Link a different chat** forgets the linked chat, so you can link another one.
- **Disconnect** removes the token and the linked chat from this Mac. The bot itself lives in your Telegram account; delete it with @BotFather (\`/deletebot\`) if you no longer want it.`
        },

        'everyday-apps': {
            title: 'Everyday apps — Text Documents, Finance',
            description: 'Text Documents (the canvas for what the assistant writes, and your own notes, kept as Markdown files), where the Journal went, and Finance: investment accounts, prices, strategy, spending.',
            actions: ['portfolio'],
            content: `## Text Documents

The canvas for what the assistant writes for you — a draft, a summary, a plan — and for anything you write yourself (the app was called Notes until 2026-10-05; every note you had is still here). Open it with Cmd+K. A three-pane notebook: filters on the left, the note list in the middle, and the note itself — always open, always editable. No Edit/Save buttons; changes autosave as you type.

- **New notes** — the "+ New Note" button in the header opens a blank note straight away.
- **Panes** — three icon buttons in the header, each a small map of the page with the pane it hides or shows shaded: the filters sidebar, the note list, and the reading pane. With the reading pane off the list takes the full width, and opening a note swaps to the full-width note with a back chip naming the list you came from ("← Pinned", "← work"). The reading pane starts off on a laptop-sized display and on in front of a large monitor. Each choice is remembered on this Mac, and the dividers between panes drag to resize.
- **Finding a note** — global search (Cmd/Ctrl+K) searches titles and bodies along with everything else; the page itself has no separate search box.
- **Formatting** — select text for a small toolbar (bold, italic, headings, quote, lists, link, and **T** for normal text), or type / on an empty line for the block menu. Markdown shortcuts work as you type (# for a heading, - for a list), and text pasted from a markdown file keeps its headings, lists, code blocks and emphasis.
- **Images** — paste an image or screenshot straight into the note body; it is stored inside the note (scaled down to keep notes light) and syncs with it.
- **Your documents are files.** Every one is also kept as a plain Markdown file in the nenva folder of your home directory (\`~/nenva/Documents/\`, images beside it in \`assets/\`). Open them in Finder or any editor, including Obsidian: edits you make to the files show up in nenva, and edits here are written back. A file you rename keeps its name. The switch and an Open Folder button are in **Settings → Advanced → Storage → Text Documents as Files** (on by default, per Mac). The older \`~/nenva/Notes/\` and \`~/nenva/Journal/\` folders are left as they are and never touched again.
- **Wiki links** — type [[ inside a note to link another note by title (or create one on the spot). A note lists what points at it under "Linked from", and notes sharing a tag appear as Related notes.
- **Tags** — click a tag pill on a note to see every note with that tag; the "Find a tag…" box in the sidebar narrows the tag list as you type.
- **Templates** — a note can be Blank, a Book (chapters behind the "Chapters" toggle), or a Prompt (a reusable instruction the assistant can run on a schedule — settings behind the "Settings" toggle).
- **AI Assistant documents** — what the assistant writes is typed "AI Assistant" with a sparkle chip; the sidebar has a filter for them.
- **Define** — select a word in any note to look it up in place.

## Where the Journal went

The Journal app left nenva on 2026-10-05. Nothing was deleted: every entry stays in nenva's data, and the app wrote one final Markdown export of all of them to \`~/nenva/Journal/\` (a notice with **Show folder** appeared once), ready for any journaling app that reads Markdown. nenva no longer reads the journal.

## Finance

One app with two halves, Investments and Spending, linked through its left nav. **Investments** tracks investment accounts (brokerage, 401k, IRA, HSA…), holdings, properties, and liabilities (mortgages, loans, credit lines). Prices refresh from Yahoo Finance; cost basis uses the average-cost method; a value-history chart shows the trend. The **Show/Hide** button in the header blanks all dollar values; Snapshot saves today's total to the history. Stored locally like everything else.

- **Accounts** — the left nav lists All Accounts plus each account with its value. Click one and the whole page scopes to it: its total, chart, holdings, and transactions, with Cash, Edit, and Delete in the header.
- **Holdings and transactions** — two tabs, at every scope. Holdings is one simple row per position; Transactions lists every buy and sell, with the account named on each row when you are looking at all accounts.
- **Properties and liabilities** — the left nav lists your real estate and your debts under Accounts, each with its value or balance, with **+ Add property** and **+ Add liability** rows. A liability is a mortgage, home equity line, auto, student or personal loan, credit card, or anything else you owe: balance, lender, rate, monthly payment, and optionally the property it is secured by. Both also appear as sections on the All Accounts view; the property page shows its mortgage and the equity left. The summary at the top is one number over a composition bar and legend that read as the equation behind it (investments + cash + real estate − debt); once any debt is on the books that number is labeled net worth. Liabilities sync between your Macs and count in the assistant's portfolio answers.
- **Live prices** — while the US market is open (9:30 AM to 4 PM New York time, weekdays, wherever you are) and a Portfolio page is on screen, US stocks and ETFs update every 15 seconds from Robinhood's public quotes, and a row tints green or red for a moment when its price moves. The caption at the top then reads **Live** with the time of the last update. Mutual funds, non-US listings and options are not on that feed and keep updating from Yahoo Finance every 5 minutes. Nothing polls when you are on another page, the window is hidden, or the market is closed.
- **Watchlist** — follow tickers you don't own. **+ Add ticker** in the Watchlist section (All Accounts view) searches by symbol or company name; each row shows the live price and day move and opens the same detail page a holding gets. On any stock's detail page, **Watch** in the header adds or removes it. The watchlist syncs between your Macs.
- **Tickers** — the **Tickers** section in the left nav lists every symbol you hold or follow on one table: shares, average cost, price, value, weight, P&L, today's move and which accounts hold it. Click a column to sort, type to filter by ticker or company name, and narrow to held or watched tickers, stocks or options, or one account. A row opens the same detail page.
- **Ticker detail** — every stock's page shows the company profile, a real market price-history chart (1M to Max ranges from Yahoo Finance, not just prices since you added the position), and **Open in** pills that jump to the ticker on research sites (Yahoo Finance, TradingView, Finviz…) in your browser. Holdings also get your own value history and per-account position tables.
- **Options** — long calls and puts are tracked next to stocks. In the transaction editor, switch from Stock to Option and fill in the underlying, call or put, strike, and expiration; quantity means contracts and price means premium, and the 100x multiplier is applied for you. Positions read as "AAPL $250 Call 12/18/26" with an expiry note that turns amber near expiry and red once expired. Short and written options are not supported.
- **Business profile** — every stock's page carries a profile written once a day by your AI model: what the company is, what it sells and how, who its customers are, how sound the business looks (growth, margins, cash against debt), where AI fits, whether the stock looks expensive, fair, or cheap on its multiples, the near-term and long-term risks and value, the recent headlines, and a bottom line. The profile ends in a row of **verdict tiles** shown above the text (valuation, how sound the business is, where AI fits, near- and long-term risk and value, the tone of the news), each one word the model chose to sum up its own profile, never a number the app computed; click a tile to jump to that part of the text. Funds get the fund version (what it holds, the expense ratio, who it is for). Every number in it comes from that day's Yahoo Finance fact sheet, never from the model's memory. Every holding and watchlist symbol gets its first profile quietly, one at a time, when you open Portfolio or the home page (not on a metered cloud model, where each is written when you open its page). After that a profile is rewritten only when you open that ticker, or ask the assistant about it, on a later day, so a symbol you do not look at costs nothing; until then the page and the Tickers table show the last one with the day it was written. If your model runs elsewhere and Portfolio data is switched off under Cloud Privacy, the page offers a button instead of writing on its own. The assistant reads the same profile when you ask what a company does, whether it is expensive, or what its risks are. Tell it when the profile is wrong or missing something ("their biggest customer is X", "I hold this for income, judge it that way"): with your approval it saves the correction as a note on the ticker and rewrites today's profile around it, and every later day's profile is written with your notes in hand. Notes on a ticker show up whenever the assistant reads it; ask it to delete one to retire it.
- **Today's brief** — the All Accounts page opens with a brief written once a day by your AI model on the market and your whole portfolio: what kind of day the market had (S&P 500, Nasdaq, Dow, Russell, VIX, the 10-year yield, gold, oil, bitcoin), what your portfolio did against it, which positions moved and what they did to the total, how the book sits against your plan, the dated headlines, what is worth watching, and a bottom line. Every number comes from the app's own figures and that day's quotes, never from the model's memory, and it describes rather than tells you what to trade. **Rewrite now** writes a fresh one on demand (after the close, after a trade); otherwise it refreshes once a day, written quietly when you open Portfolio or the home page (on a metered cloud model, when you open All Accounts). If your model runs elsewhere and Portfolio data is switched off under Cloud Privacy, the page offers a button instead of writing on its own. The assistant reads the same brief when you ask how the market or your portfolio did today, and **Ask about this brief…** under it opens a chat with the brief as the subject (the ticker page's profile has the same **Ask about this profile…** door).
- **News on your holdings** — a ticker's page lists recent headlines about that company, and the account pages and All Accounts collect headlines across the holdings (largest positions first; index funds are left out so companies are not crowded out). A headline opens in your own browser. Needs web access on; the assistant reads the same headlines when you ask about a stock.
- **Current headlines from CNBC** — off by default. After you have used Portfolio for a few days, nenva asks on your Now page whether you want them (one tap); change your answer any time in **Memory → Preferences**, or just tell nenva. All Accounts (under the brief) and each ticker page (under the profile) then show a short summary of what CNBC is running now, written by your AI model from CNBC's own headlines and rewritten every 10 minutes while the section is on screen, or with **Refresh now**. A ticker page only counts a CNBC story that names the symbol or the company. Needs web access.
- **Turning the AI writing off** — once a brief has been written, nenva asks on your Now page whether to keep writing them (one tap); change your answer any time in **Memory → Preferences**, or just tell nenva. It covers both the business profiles and Today's brief. Off, neither is written and neither is shown (one written on an earlier day could read as current); prices, holdings, strategy and headlines are unaffected.
- **Prices** — quotes include pre-market and post-market moves when the market is closed. For shares you bought today, day change is measured from your purchase price rather than yesterday's close.
${typeof FEATURES !== 'undefined' && FEATURES.isEnabled('sharing') ? `- **Sharing** — share one account read-only with another nenva user. Pair with the other person by invite code under **Settings → Advanced → Telegram → Contacts**, then use **Share** on the account. Their Mac shows it under **Shared with you**, left out of their totals; **Revoke** removes it. Everything travels end to end encrypted between the two Macs through nenva's relay, which sees only ciphertext and keeps no record of who shares with whom. For now both Macs have to be open and online for a share or an update to arrive, and a shared copy that hears nothing for 30 days removes itself.
` : ''}
### Strategy

A strategy is the plan behind the holdings: what the money is for, when you need it, how big a drop you can sit through, a target mix, and the limits you want to hold yourself to. **Plan** in the accounts nav opens it. The quiet strategy line above your holdings goes to the same place, and at account scope it says whether that account has its own plan or follows the overall one.

The Plan page is for reading, not filling in. It shows the plan in your own words, a **target mix** table (each sleeve with its tickers, target against actual, a bar marking the tolerance band, and what to trim or add in dollars to get back to target), a list of your **guardrails** with a pass or fail beside each, and a one-line verdict: On plan, Drifting, or Off plan. Every number there is computed by the app, using the same arithmetic the assistant and the home widget use, so the page and the chat can never disagree. Anything that changes the plan is a button that hands the question to the assistant, and **Ask about this strategy** opens a chat with that plan already in context. **Review it every weekday morning** schedules a routine whose latest read appears beside the plan.

Click a plan's **name** to open the plan's own page: everything above plus the accounts actually following it (each a link to that account) and the plan's change history. The questions offered there fit the plan's state — a draft offers to be finished, a drifting plan offers the way back to target.

You do not fill in a form. Ask the assistant to build one and it interviews you, one question at a time, explaining why each part matters, because most people have never been asked these questions. It proposes a target mix based on your answers and what you already hold, you correct it, and it saves the plan. An interrupted conversation leaves a draft you can pick up later.

Once saved, the plan is measured against your real holdings: on the Plan page and whenever you ask the assistant. Adding a transaction that puts you off plan says so at the time.

Accounts follow the overall strategy unless you tell the assistant to give one its own. That helps when, say, a Roth should be judged differently from a taxable account.

### Scheduled review

No routine reviews the portfolio until you ask for one. Tell the assistant, for example, "review my portfolio every weekday after the market closes" and it sets up a routine (you approve it first, after seeing one try). It runs with read-only tools, and you can change the time or turn it off from its page under Standing on the Chats page.

### Spending and the money coach

**Spending** shows what you spent, by month and by account, once a bank can be linked; it has no budgets, by decision. Whether or not a bank is linked, the assistant coaches your money as a whole: it reads one fact sheet joining your accounts, the bills and subscriptions found in your mail, and your money goals, and raises a card on Now when something is worth your attention (at most two at a time). Ask it about your money in any chat; a money goal is a commitment, and the household plan is a conversation, not a form. It may point at a specific stock or fund from facts the app holds, but it never predicts, and nothing is paid, moved, bought or sold from here.`
        },

        'how-anjadhe-works': {
            title: 'How nenva works — privacy, one Mac and your phone',
            description: 'Where data lives, one Mac plus the iPhone app (sync between Macs was retired), getting around (New chat, Now, Chats, Settings, Cmd+K), keyboard shortcuts, Documents, your writing voice.',
            actions: ['storage-backup', 'privacy-security', 'developer', 'ai-logs'],
            content: `## Privacy & your data

nenva is private by default. No remote database, no account. Data is stored on this Mac in the standard macOS Application Support area. AI runs where you choose — this Mac (default), a server you own, OpenAI/Anthropic with your own key, or nenva cloud if you chose it. **Settings → Model** shows where your AI runs, and **Settings → Connectors** explains what each connected source provides. Backups live in **Settings → Backup**. **Settings → Advanced → Developer → Data activity** lists every call that went to a server, and the work nenva kept here instead. The developer's full logs of every AI call, web search and network request are behind **Settings → Advanced → Developer**: machine-local, never synced, and never sent to anyone.

## One Mac, and your phone

nenva runs on one Mac, with the iPhone app as its extension: pair the phone in **Settings → Advanced → Paired Devices** and it works with the same data through that Mac. **Syncing between Macs was retired** (2026-09-30); each Mac that runs nenva keeps its own data. To move to a new Mac, restore a backup there (**Settings → Backup**).

## Getting around

nenva is three pages and a chat. The nav on the left has **New chat**, **Now** (the day, one card at a time), **Chats** (every conversation, your jobs and your standing routines) and **Settings**. Everything else — Text Documents, Documents, Finance, Insights, Help — opens by name from **Cmd+K**, or from a card or a link that leads there; a page you drilled into has a back link naming where you came from.

## Keyboard shortcuts

- **Cmd+K** — the launcher and search in one. It opens with your most-used apps listed; type to narrow to any app, or to a text document, a document or a commitment by name.
- **Cmd+/** — open the assistant panel over whatever you are looking at
- **Cmd+R** — refresh
- **Esc** — close the open post, menu, or overlay
- **Enter** in any quick-add box — create the item

## Documents and your writing voice

**Documents** — the user's repository for their digital documents (PDFs, scans and photos of paper read with the Mac's own OCR, spreadsheets, Word/PowerPoint files, RTF, web pages, notes), parsed and indexed on this Mac and ORGANIZED WITH TAGS. Add them with **Add files** at the top of the Documents page (Memory › Documents), drag-drop anywhere on its list (while a tag is chosen, what lands wears it), ask the assistant to save a file attached in a chat ("save this to my documents"; tagged as asked, else "From chats"), or Finder-drop into the folder (~/nenva/library/); supported: .pdf, .png/.jpg/.heic and other images, .docx/.doc/.rtf/.odt, .xlsx/.csv, .pptx, .md/.txt/.html. **Tags**: hover a row → "+ tag", or the tag strip while reading; a slash makes a level ("Finance/Taxes/2025" shows under Finance, Taxes and 2025 in the tree on the left); click a chip to filter, × to remove, "Rename tag" renames it everywhere; to create a child tag, hover a tag in the tree and click its "+" ("+ New" at the top for a top-level one), name it, and it is selected and ready — drop files on it (or anywhere while it is selected) to import them tagged, drag a document row onto it, or hover a row and click "+ tag" (the picker starts with the selected tag's path); "Untagged" collects what still needs filing. Searching shows passages grouped by document (inside the selected tag when one is chosen); opening one shows the text — TIDIED WITH AI once per document (paragraphs rejoined, headings/tables restored, nothing summarized or added; saved once as a Markdown sidecar in the folder's hidden .anjadhe/tidy so it is never regenerated for an unchanged file, on any Mac sharing the folder; automatic when the AI model is on this Mac, otherwise a "Tidy with AI" button unless Files may leave this Mac in Cloud privacy) — or, when the AI model can SEE images (a local model with its vision file, or a vision-capable cloud model), READ FROM THE PAGE IMAGES by the vision model (far more accurate than the PDF text layer; that transcription becomes the document's text for search and the assistant; first 25 pages automatic, the rest on a click; a document parsed or OCR'd earlier shows "Re-read with vision" in the banner to reprocess it) — with a banner saying which view is up and "Show extracted text" to flip back (matches are marked in the extracted view) — plus Open original / Show in Finder / Ask about this document (the assistant then knows what's open; it always reads the extracted text, never the rewrite). The assistant can search (search_library, optionally within a tag), list by tag (list_documents), read a document (read_library_doc) tag documents on request (tag_document) and save a file attached in the chat into Documents (save_to_documents). Cmd+K finds documents by title or tag. Deleting a document moves the file to the macOS Trash. Semantic search needs a one-time ~330 MB model download in **Settings → Advanced → Documents** (also index status, Rescan/Re-index, the folder location); until then search is keyword-only. Parsing, OCR and indexing always run locally — only passages retrieved for a question travel with that chat turn. Tags sync between Macs (the index is rebuilt on each).

**Writing voice** — removed from Settings on 2026-10-06; a voice studied before then is still used when you ask ("write this in my voice"). The page used to let you turn it on and pick what it learns from — documents you add (Add documents… or drag-drop onto the page), your text documents, and your **sent emails** (only the parts you wrote: quoted replies, forwarded messages and signatures are stripped before anything is studied). Each source is a switch you can change any time; nothing is read until you press **Study**. Study reads a spread sample on the AI model you chose (**Study depth** on the same page sets how much) and writes a short, editable style guide plus verbatim passages of your writing. Edits to the guide stick — re-studies never overwrite them — and passages can be pinned or removed. To use it, ask any chat: "write this in my voice", "make it sound like me", "reply the way I would" — the assistant fetches the guide and passages first, then writes; **Draft in my voice…** on the settings page opens a chat already primed. There is one voice, the user's own; voices built from other people's writing are not a feature. Routines and other automatic writing use the assistant's own voice. **Turn off** removes the guide and passages; documents, text documents and emails stay where they are. No fine-tuning, no hidden style profile: the guide is a page you can read and change. Documents given to the voice are also visible in the Documents app — same folder.`
        },

        'license': {
            title: 'License and registration',
            description: 'Cloud pricing (nenva cloud lite and pro are planned at-cost services), the free license and what the email is used for, how to get it or enter a key, what a license does.',
            actions: ['license'],
            content: `## Cloud pricing

**nenva cloud lite** and **nenva cloud pro** are planned paid services priced at cost: inference usage plus a share of cloud hosting, with no markup. Pro uses a more capable model whose inference cost can differ from lite. Rates and billing are not available yet; today cloud has a free monthly allowance, as does web search through nenva Connect. Choosing a model does not subscribe or charge you.

## Get your free license

On the first-time welcome page, enter your email and choose **Get started**. Email registration is required to finish setup. If registration fails, check your connection and try again. Your license is in **Settings → About → Registration**. Your email is for product updates and new features. Unsubscribe anytime. Unsubscribing keeps your license.

The address also gets you the same license back: on another Mac, or after a reinstall, get a license again with the same address and you receive the same key. The license is a small signed key saved on this Mac. No account is created.

## Already have a key

The same page also takes a key directly: paste it into the box and press **Apply key**, or **Open file…** if it came as a file. The card then shows who it was issued to and when.

## What a license does

A license registers you, and email registration is required during first-time setup. Every install gets every update, and **no feature is locked**. A free license does not include paid cloud usage. Cloud billing is not built yet.

Verification happens on this Mac with a public key. Nothing is looked up online to check a license, and nothing about you is sent when it is verified.

## Removing a license

**Remove from this Mac** on that page forgets the key on this Mac only. It is not revoked and nothing is sent; enter it again any time.`
        },
        'settings': {
            title: 'Settings reference — the one page, and everything behind it',
            description: 'Map of Settings: the one page (Model, Connectors, Privacy, Backup, Appearance, About, Advanced; Memory, with Commitments and what nenva tracks from mail, is its own nav item) and the Advanced list (Name, Model options, Web Search, Tool Servers, Permissions, the logs, Telegram, Paired Devices, Storage, Documents, Finance, Developer).',
            actions: ['ai-models', 'accounts', 'appearance'],
            content: `**Settings** in the left nav is ONE page of rows, each showing its current value:

- **Model** — the one model everything runs on, and where it runs (this Mac, nenva cloud, your own server or key). Choosing one here makes it the default for every part of the app.
- **Memory** — everything nenva remembers about you, under About you, People, Work, Preferences and Plans; click a fact to fix it, star it, or forget it. **Commitments**, the list of everything you said you would do, is a row at the top of this page.
- **Connectors** — one searchable list of every outside source nenva reads (Gmail, Google Calendar, Apple Calendar, Apple Reminders, Apple Notes, Texts, Files, Notion, ${typeof FEATURES !== 'undefined' && FEATURES.isEnabled('slack') ? 'Slack, ' : ''}Linear), each with its own connection controls and description of what it reads.${typeof FEATURES !== 'undefined' && FEATURES.isEnabled('slack') ? ` For Slack, choose Connect Slack and sign in to authorize your workspace. Sign-in enables on-demand access only. In builds with monitoring enabled, Keep an eye on Slack lets you choose conversations and confirm the model that reads them. Monitoring looks for requests, commitments, changed decisions and blockers; optional morning reviews reuse those findings and stay quiet without meaningful changes. Pause or stop from the Slack connector page.` : ''}
- **Plan** — your nenva cloud and web search plan: this month's nenva cloud use as a percentage (with how much went to background work like reading email and routines), web searches used out of the month's allowance, and when they reset. Here you can choose a paid plan (Plus or Pro, monthly or yearly; you pay on Stripe's page in your browser, which shows the price first), enter a plan code from another Mac or your receipt (**I have a code**), manage or cancel a subscription (**Manage subscription**), show the code to use the plan on another Mac, remove the plan from this Mac, or add a one-time top-up when you run low. Paid plans are sold only on a Mac whose region is the United States for now (System Settings → General → Language & Region); elsewhere the page says so, and a plan code bought in the US still works there. Your own search key (Settings → Advanced → Web Search) is never counted. nenva local has no monthly limit. When the month's nenva cloud allowance is used, cloud stops until it resets; nenva never switches you to another model by itself.
- **Privacy & security** — two rows: **App lock** and **Share usage statistics**. Each opens its own page with details and controls. Model choices and source permissions live under **Model** and **Connectors**.
- **Backup** — one switch, the folder, how often, Back up now, the passphrase as one row, Restore from a backup.
- **Appearance** — Light, Dark or System; **Keep nenva running** (closing the window keeps it in the menu bar so routines continue; the menu bar has Open nenva, Pause scheduled routines and Quit) and **Open at login**. While routines are scheduled, nenva keeps the Mac awake so they run on time, on battery too; the display still sleeps, and Pause scheduled routines lets the Mac sleep.
- **About** — version and updates, Send feedback, Registration (your free license), About nenva.
- **Advanced** — the list below: only what this page does not cover.

## Advanced

Only what the one page does not cover; everything a person needs day to day is a row on the page above.

- **Name** — give the assistant a name; it replaces the "AI Assistant" label across the app and the assistant answers to it.
- **Model options** — per-model Manage panels (keys, options, sharing on the local network) and the local engine's update row. Choosing the model is **Settings → Model**.
- **Web Search** — the **Enable web search** switch, the nenva Connect card (plan, usage, Test), plus Tavily / Brave key cards for direct-to-provider searches.
- **Tool Servers (MCP)** — advanced setup for custom external tool servers. Compatible HTTPS servers can use **Add Server → Sign in with browser (OAuth)**. Notion${(typeof FEATURES !== 'undefined' && FEATURES.isEnabled('slack')) ? ', Slack' : ''} and Linear have simpler pages under **Settings → Connectors**; choose Connect and sign in through the service in your browser.
- **Permissions** — standing grants the assistant has been given (files, shell, servers, sending); review or revoke.
- **Telegram** — chat with this Mac's assistant from Telegram. iMessage reading permissions and your number for requested texts are in **Settings → Connectors → Apple Messages**.
${typeof FEATURES !== 'undefined' && FEATURES.isEnabled('mobilesync') ? `- **Paired Devices** — the iPhone app's pairing.
` : ''}- **Storage** — the database's location, disk usage, **Text Documents as Files**, the database browser. Backups and the passphrase are **Settings → Backup**.
- **Documents, Finance** — the Documents index (semantic model, index status, the folder); Finance's AI writing and headline switches.
- **Developer** — DevTools, Data activity, the logs.

### Developer
- **Developer Tools** — inspect/debug (Chrome DevTools).
- **Data activity** — a summary of recent AI requests and web searches by date, service and kind, including work kept on this Mac.
- **LLM Logs, Web Search Logs, Network Logs** — the developer's audit: every AI call with the messages it carried and the reply, every web search query, every server this app connected to. Machine-local, never synced, never sent to anyone. The plain-language version is **Settings → Advanced → Developer → Data activity**.`
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
