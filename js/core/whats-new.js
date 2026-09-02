/**
 * WhatsNew — the titlebar "What's new" chip shown once after each update.
 *
 * RELEASES holds a hand-written summary per release: only changes a user
 * can see or feel, in simple English — never the full changelog
 * (RELEASING.md step 2b). The chip appears when the running app's version
 * matches the newest entry and this Mac hasn't opened it yet; clicking
 * opens a minimal summary page (a modal) and puts the chip away.
 *
 * Seen-state is deliberately machine-local (localStorage, same precedent
 * as the update card's dismissal): each Mac updates on its own schedule,
 * so reading the notes on one Mac must not hide them on another that
 * hasn't updated yet. Fresh installs never see the chip — everything is
 * new on day one, so the current version is marked seen during setup.
 *
 * "Earlier releases" (2026-08-25) is the public changelog, fetched from
 * the website's /changelog.json — the same file that renders
 * anjadhe.ai/changelog, generated from this repo's release-notes/ at
 * release time. It is release metadata, not personal data: the request
 * carries nothing about the user, and it is made only when the user opens
 * that view. Offline, the RELEASES list below is the fallback.
 */
const WhatsNew = {
    SEEN_KEY: 'anjadhe_whats_new_seen',
    CHANGELOG_URL: 'https://anjadhe.ai/changelog.json',
    CHANGELOG_PAGE: 'https://anjadhe.ai/changelog',
    FOUNDER_MAILTO: 'mailto:founder@anjadhe.ai?subject=Anjadhe%20feedback',

    // Newest first. Keep each body to one or two plain sentences.
    RELEASES: [
        {
            version: '0.1.0-alpha.58',
            date: 'September 1, 2026',
            highlights: [
                { title: 'Claim your free alpha license', body: 'Alpha users keep Anjadhe free for good, and now that is a key you hold: a small signed license saved on this Mac, no account. Claim it from the Home checklist or Settings › License; it asks for an email only so the same key can be issued to you again.' },
                { title: 'Settings › License', body: 'See the license this Mac holds, paste a key or open a license file, or forget it. A license never locks a feature; it only decides which releases the updater may install once the alpha closes.' },
                { title: 'Reminders as iMessages', body: 'Settings › Accounts › iMessage texts this Mac\'s reminders and alerts to your own iMessage through the Messages app — from you, to you, nothing in between. The assistant never reads your messages.' },
                { title: 'The iPhone app is native', body: 'The phone\'s screens are now built in Swift. Same pairing, same encrypted channel, same Mac brain.' }
            ]
        },
        {
            version: '0.1.0-alpha.56',
            date: 'September 1, 2026',
            highlights: [
                { title: 'Talk to your Mac from Telegram', body: 'Create your own bot, paste its token in Settings › Accounts › Telegram, and link one chat — your messages run on your Mac\'s assistant and reply right there. Optionally, your Mac\'s reminders and notices forward to that chat too.' },
                { title: 'The assistant leads on your phone', body: 'The phone app now opens on an Assistant tab: chat runs on your paired Mac\'s brain over the same encrypted connection sync uses, and the conversation syncs back. New phone screens for Email AI, Projects, News, Portfolio and Wellness came along.' },
                { title: 'Faster phone sync at home', body: 'On your home network the phone connects straight to your Mac instead of going through the relay. The Sync screen shows which path is in use.' },
                { title: 'Emails with "renews in 30 days" get real dates', body: 'An exact stated offset now becomes the actual date, counted from the email itself — vague windows like "3-5 business days" stay dateless on purpose.' }
            ]
        },
        {
            version: '0.1.0-alpha.55',
            date: 'August 31, 2026',
            highlights: [
                { title: 'Your voice takes center stage', body: 'The Writing Voices page in Reader now opens on your own voice: turn it on, pick what it may learn from — Notes, Journal, sent emails, or documents you add — and Study builds a style guide from your real writing. Sent mail is only read where you wrote it; quoted replies and signatures are stripped.' },
                { title: 'Goals are now Projects', body: 'Same records, same links, new name everywhere. Saying "goal" to the assistant still works.' },
                { title: 'Tasks from email, in one place', body: 'A new From email filter in Tasks shows everything the email pipeline created, and each of those tasks names the message it came from. Emails about attending something — a webinar, a school event — now land on your schedule too.' },
                { title: 'Simpler setup, honest asks', body: 'Setup is three quick steps. The first web search now asks you in the moment instead of during setup, and turning on Mac-to-Mac sync lives in Settings › Storage & Backup.' }
            ]
        },
        {
            version: '0.1.0-alpha.54',
            date: 'August 31, 2026',
            highlights: [
                { title: 'Assistant page styling fixed', body: 'alpha.53 left parts of the AI Assistant page unstyled — routine chips and task cards rendered as bare text. Everything is dressed again.' }
            ]
        },
        {
            version: '0.1.0-alpha.53',
            date: 'August 31, 2026',
            highlights: [
                { title: 'Install and uninstall built-in apps', body: 'The More apps page can now uninstall the apps you don\'t use — Wellness, Portfolio, News, Journal and more. An uninstalled app disappears completely (its page, home card, search results, and the assistant\'s tools for it), but your data stays on this Mac and everything returns when you install it again.' },
                { title: 'Move many tasks at once', body: 'Ask the assistant to "push everything to next week" or "move today\'s tasks to tomorrow" and it happens in one step, with the exact dates shown for your approval first.' },
                { title: 'Your model choice is final', body: 'A request now runs on exactly the AI brain you picked — no silent fallback to another engine — and if it fails you see that engine\'s real error. Also fixed a connection error that could appear right after a streamed local reply.' },
                { title: 'Maker is retired', body: 'The experimental artifact builder is gone. Building your own apps with a coding agent pointed at ~/Anjadhe/apps/ is the way to build, and the assistant now points there instead of offering builds it can\'t do.' }
            ]
        },
        {
            version: '0.1.0-alpha.52',
            date: 'August 29, 2026',
            highlights: [
                { title: 'See what an update brings before you restart', body: 'The "Update ready" card on the home page now links to that version\'s release notes, so you can read what changed and decide whether to restart now or let it install when you next quit.' }
            ]
        },
        {
            version: '0.1.0-alpha.51',
            date: 'August 29, 2026',
            highlights: [
                { title: 'The assistant can read your journal', body: 'Asking about an entry you wrote today used to come back empty, and the assistant could only see the first few lines of any entry. It now finds entries by your local day and can read a whole entry, so "read what I wrote and suggest something" works on the actual writing. Journal stays on this Mac for background work unless you switch it on in Cloud Privacy.' },
                { title: 'Leftover model servers are cleaned up', body: 'A crash or force quit could leave a half-gigabyte embedding server running on a side port for days. Anjadhe now reclaims those at startup.' }
            ]
        },
        {
            version: '0.1.0-alpha.50',
            date: 'August 28, 2026',
            highlights: [
                { title: 'News reads like a feed', body: 'The News page is now one scrolling timeline: each headline is a post with the publisher\'s icon, the source and the story\'s age. The headlines themselves still come straight from news feeds — no AI writes them.' },
                { title: 'Topics as tags', body: 'Every post shows its topic as a small tag. Click it to see just that topic\'s stories; the topics rail works as before.' }
            ]
        },
        {
            version: '0.1.0-alpha.49',
            date: 'August 27, 2026',
            highlights: [
                { title: 'News on your holdings', body: 'A ticker page in Portfolio now lists recent headlines about that company, and account pages collect headlines across your holdings. A headline opens the News reader with a summary written on your Mac; the assistant reads the same headlines when you ask about a stock or in the Market Review.' },
                { title: 'Reader mode shows the date', body: 'The web browser\'s reader now shows an article\'s author, publication date, subtitle and reading time in a proper header, and no longer repeats the headline or "By …" lines inside the text.' },
                { title: 'Smaller local models', body: 'Qwen 3.5 9B (16 GB Macs) and 4B (8 GB Macs) are back in the model list, so a local assistant is available on more machines.' },
                { title: 'Help answers are back', body: 'The assistant\'s built-in help stopped loading in the last release, so "how do I…" questions went unanswered. Fixed.' }
            ]
        },
        {
            version: '0.1.0-alpha.48',
            date: 'August 26, 2026',
            highlights: [
                { title: 'Your notes are files', body: 'Every note and journal entry is now also a Markdown file in ~/Anjadhe/Notes and ~/Anjadhe/Journal. Open them in Finder or Obsidian; edits flow both ways. Settings › Storage & Backup has the switch.' },
                { title: 'What Anjadhe will cost', body: 'Free during alpha. A one-time license of about $79 is planned later, and alpha users keep the app free for good. The Closed Alpha pill in About has the details.' }
            ]
        },
        {
            version: '0.1.0-alpha.47',
            date: 'August 26, 2026',
            highlights: [
                { title: 'The assistant reads email images', body: 'On a model that can view images, asking about an email now includes its pictures: inline images and attached photos or screenshots. A bill that arrived as a screenshot is read as part of the email.' },
                { title: 'After-hours quotes, inline', body: 'In Portfolio holdings the pre- and after-hours quote sits beside the price instead of on its own line, and the accounts sidebar can be collapsed.' },
                { title: 'support@anjadhe.ai', body: 'Every contact link in the app and on anjadhe.ai now reaches the support address.' }
            ]
        },
        {
            version: '0.1.0-alpha.46',
            date: 'August 26, 2026',
            highlights: [
                { title: 'When a note was written', body: 'The line under a note’s title now shows when it was last edited and when it was created. Hover for the exact times.' },
                { title: 'Portfolio Show values, fixed', body: 'The eye button sometimes did nothing after you had visited a ticker or property page and come back. It now always repaints the page on screen.' }
            ]
        },
        {
            version: '0.1.0-alpha.45',
            date: 'August 25, 2026',
            highlights: [
                { title: 'Portfolio mix in color', body: 'The asset-class bar at the top of Portfolio colors investments, cash and real estate so the mix reads at a glance. Debt stays outlined in red.' }
            ]
        },
        {
            version: '0.1.0-alpha.44',
            date: 'August 25, 2026',
            highlights: [
                { title: 'Every release, right here', body: 'Earlier releases below (and About › Changelog) lists what changed in every version, newest first, from anjadhe.ai/changelog.' },
                { title: 'Contact the founder', body: 'A direct email link in About, Settings › Send Feedback and this window. Bug reports and "I’m lost" messages go straight to the person who wrote the app.' },
                { title: 'Release notes by email', body: 'On anjadhe.ai/download you can leave an email to get one message per release. No account, and unsubscribing deletes your address.' }
            ]
        },
        {
            version: '0.1.0-alpha.43',
            date: 'August 25, 2026',
            highlights: [
                { title: 'Paste markdown into Notes', body: 'Text copied from a markdown file arrives as real headings, lists, quotes and code blocks, with bold, italic and links kept.' },
                { title: 'Back to normal text', body: 'The note editor’s selection toolbar has a T button (also Cmd+Shift+0 and "Text" in the / menu) that turns a heading or quote back into a plain paragraph.' },
                { title: 'A warning before closing mid-task', body: 'If the assistant, a task run or a build is still working, closing the window or quitting asks first, the way Cmd+R already did.' }
            ]
        },
        {
            version: '0.1.0-alpha.42',
            date: 'August 25, 2026',
            highlights: [
                { title: 'See exactly what leaves your Mac', body: 'When your model runs on Anjadhe Cloud or your own key, Settings › AI Assistant › LLM Logs has a "Left this Mac" view listing every request that went out, with the exact messages it carried. The model chip shows a small arrow whenever answers come from off this Mac.' },
                { title: 'Cloud Privacy switches', body: 'Settings › AI Assistant › Cloud Privacy decides which kinds of data background work (email insights, routines, reviews) may send to a cloud model. Journal and Wellness stay on your Mac unless you say otherwise. Chat always sends what you typed.' },
                { title: 'Less goes than before', body: 'Email bodies lose quoted history, signatures and tracking links before background analysis leaves this Mac, and background prompts are capped in size.' },
                { title: 'Anjadhe Cloud, checkable', body: 'The Anjadhe Cloud card states its commitments in checkable sentences, names DeepInfra as the inference provider, and shows the commit the server is running so you can compare it with the public code.' },
                { title: 'Liabilities in Portfolio', body: 'Mortgages, loans and credit lines live alongside your assets; the masthead shows net worth when you carry debt.' },
                { title: 'Models grouped by where they run', body: 'Settings › Models and the model dropdown group entries by where the model runs: this Mac, your server, an API provider, Anjadhe Cloud.' }
            ]
        },
        {
            version: '0.1.0-alpha.41',
            date: 'August 21, 2026',
            highlights: [
                { title: 'Apps greet you now', body: 'An app you haven’t set up yet opens on a short welcome — what it does and the door in — instead of an empty pane.' },
                { title: 'Quick-start suggestions on Home', body: 'A few prompt pills under the composer suggest things worth asking. The set stays put all day.' },
                { title: 'Smoother on Anjadhe Cloud', body: 'Task runs pace themselves and wait when the service asks, so long jobs no longer die mid-step to the rate limit — and a working cloud model is no longer flagged as "not installed".' },
                { title: 'Truthful task reports', body: 'Work the assistant finished in one pass is no longer reported as failed just because it couldn’t be checked off item by item.' },
            ],
        },
        {
            version: '0.1.0-alpha.40',
            date: 'August 21, 2026',
            highlights: [
                { title: 'Email analysis plays nice with Anjadhe Cloud', body: 'Connecting an email account no longer trips the cloud rate limit: analysis paces itself, and when the service asks it to slow down it waits and retries — no email is skipped, no insight loses its booking details.' },
                { title: 'A tidier set of apps, and a More apps page', body: 'New installs start with the essentials; everything else waits on the More apps page — one card per app with a description and a switch. Turning an app off keeps its data, and Cmd+K still finds it by name.' },
                { title: 'Bookmarks moved into the Web Browser', body: 'Every new tab shows your bookmarks, and its Manage button opens the full Bookmarks page.' },
                { title: 'Actions is now called Tasks', body: 'Same app, named for what it holds.' },
            ],
        },
        {
            version: '0.1.0-alpha.39',
            date: 'August 20, 2026',
            highlights: [
                { title: 'Bring in your Apple Reminders, Notes, and Calendar', body: 'Settings › Accounts › Apple apps imports this Mac’s reminders into Tasks (repeats and lists included), notes into Notes, and shows Apple Calendar events in the Calendar. Everything is read on this Mac — no Apple password, nothing written back — and turning a switch off removes what it brought in.' },
                { title: 'Tag your tasks', body: 'Tasks now take tags: add them in the task editor, see them as chips on task rows, and find everything with a tag from the new Tags section in the Actions sidebar. Imported reminders arrive tagged with their Reminders list.' },
                { title: 'Notes: a way back from a tag', body: 'Viewing a tag with the sidebar hidden now shows an “← All notes” chip instead of leaving you stranded.' },
            ],
        },
        {
            version: '0.1.0-alpha.38',
            date: 'August 19, 2026',
            highlights: [
                { title: 'Pick your Anjadhe Cloud model', body: 'Adding Anjadhe Cloud now shows the models on offer, each with a short description. Add one or several — they sit in Your Models like any other and switch from the model chip.' },
                { title: 'Cloud model names stay current', body: 'When a hosted model is renamed on the service, the app picks up the new name at next launch.' }
            ]
        },
        {
            version: '0.1.0-alpha.37',
            date: 'August 19, 2026',
            highlights: [
                { title: 'Routines wait out AI outages', body: 'If the AI model is unreachable when a routine runs, the run now keeps retrying in the background for hours instead of skipping until the next scheduled day. The moment a model is back, waiting routines run.' },
                { title: 'The email under its insight', body: 'Opening an insight in Email AI now shows the full original message right below it, so you can check what the summary says against the mail itself.' },
                { title: 'Disk space read correctly', body: 'Asking the assistant about free disk space on your Mac now gets the real numbers. macOS reports the system volume in a misleading way that could read as almost-full or almost-empty.' }
            ]
        },
        {
            version: '0.1.0-alpha.36',
            date: 'August 19, 2026',
            highlights: [
                { title: 'Trips', body: 'Your flight, hotel and car reservations group themselves into trips. A coming trip gets its own card on Home, and the Trips entry in Email AI keeps the index of upcoming and past ones.' },
                { title: 'Mention a record with @', body: 'Type @ in the assistant message box to attach the chat to a task, goal, note, routine, strategy or account. The assistant then knows its current state in every later message.' },
                { title: 'Reschedule a whole plan at once', body: 'Tell the assistant "start this goal today" and every task in the plan moves together, spacing kept, with a before-and-after preview to approve.' },
                { title: 'Email AI reads the whole email', body: 'Messages with no plain-text part were being judged from their one-line preview. Now the full text is read, so insights for that mail are far more accurate.' },
                { title: 'Paste images into notes', body: 'A screenshot pastes straight into the note body and syncs with it.' }
            ]
        },
        {
            version: '0.1.0-alpha.35',
            date: 'August 10, 2026',
            highlights: [
                { title: 'Reader', body: 'A new app for your imported documents. Search everything by meaning, read in place with matches marked, and "Ask about this document" starts a chat that stays attached to it.' },
                { title: 'Writing Voices for everyone', body: 'No longer experimental. Two sample voices — Mark Twain and Abraham Lincoln — import with one click, and a routine can post its digests in a voice you taught.' },
                { title: 'Wellness coaches you now', body: 'Type "BP 128/82 after my walk" in the new quick-log line and it is logged with every detail. The page shows your streaks and trends, and one click arms a weekly review or daily motivator.' },
                { title: 'Notes panes collapse', body: 'The filters column and the note list each get their own toggle, remembered on this Mac. Clicking between paragraphs no longer adds stray empty lines.' }
            ]
        },
        {
            version: '0.1.0-alpha.34',
            date: 'August 8, 2026',
            highlights: [
                { title: 'Writing Voices (experimental)', body: 'Create a named voice — yours, or anyone whose writing you have — add documents, and press Study. The assistant learns how that voice writes and can draft in it, naming the documents it drew on. Turn it on in Settings › Developer › Experimental features.' },
                { title: 'The assistant is in the sidebar', body: 'AI Assistant now sits at the top of the sidebar and first in the app switcher, right under Home.' },
                { title: 'Connecting an account syncs right away', body: 'Connect Google from anywhere and the first email and calendar fetch starts immediately — no more empty app until you open it.' },
                { title: 'Email AI opens insights in place', body: 'Rows on the overview open right there and back returns to the overview, instead of jumping you into a folder. Connecting an account is now a button on the empty state.' },
                { title: 'Fixes the alpha.33 launch crash', body: 'alpha.33 could not start after updating and was pulled. This release carries everything it had, plus the fix.' }
            ]
        },
        {
            version: '0.1.0-alpha.33',
            date: 'August 8, 2026',
            highlights: [
                { title: 'Writing Voices (experimental)', body: 'Create a named voice — yours, or anyone whose writing you have — add documents, and press Study. The assistant learns how that voice writes and can draft in it, naming the documents it drew on. Turn it on in Settings › Developer › Experimental features.' },
                { title: 'The assistant is in the sidebar', body: 'AI Assistant now sits at the top of the sidebar and first in the app switcher, right under Home.' },
                { title: 'Connecting an account syncs right away', body: 'Connect Google from anywhere and the first email and calendar fetch starts immediately — no more empty app until you open it.' },
                { title: 'Email AI opens insights in place', body: 'Rows on the overview open right there and back returns to the overview, instead of jumping you into a folder. Connecting an account is now a button on the empty state.' }
            ]
        },
        {
            version: '0.1.0-alpha.32',
            date: 'August 7, 2026',
            highlights: [
                { title: 'Every app is one click away', body: 'A sidebar down the left of the window lists all your apps, grouped by what they are for, and marks the one you are in. It shows the same apps as the grid button in the titlebar, so hiding an app in Customize takes it out of both.' },
                { title: 'Collapse it when you want the room', body: 'The Collapse control at the foot of the sidebar narrows it to icons and remembers that on this Mac. On a narrow window it collapses on its own.' }
            ]
        },
        {
            version: '0.1.0-alpha.31',
            date: 'August 6, 2026',
            highlights: [
                { title: 'New email shows up within a minute', body: 'Anjadhe used to check Gmail every 3–10 minutes while you were away from the Mac — exactly when a confirmation email would land and sit invisible here. It now checks every minute while the app is running, and immediately when the Mac wakes.' },
                { title: 'Chats pinned to a task or goal keep their subject', body: 'A conversation attached to a record used to forget what it was about when you continued it from the Assistant view. It now always knows its task, goal, note, routine, strategy or account — with its current state.' },
                { title: 'The fine print is in the app now', body: 'The About footer links the Terms of Service and Privacy Policy, and the Strategy page notes that Anjadhe is not an investment adviser.' }
            ]
        },
        {
            version: '0.1.0-alpha.30',
            date: 'August 6, 2026',
            highlights: [
                { title: 'Decisions stay with the thing they\'re about', body: 'Settle a plan with the assistant — a strategy\'s monthly investment schedule, a rule for one task — and it\'s saved on that record (with your OK) and honored in every later conversation. Each task, goal, strategy, account and routine page shows its decisions, where you can add or remove them yourself.' },
                { title: 'Goals opens fast again', body: 'A goal with a long task list was making the whole page crawl. Fixed.' },
                { title: 'Briefing links hold up', body: 'Task links in routine posts sometimes rendered as dead underlined text when the model wrote the link slightly wrong. The common misspellings now work.' },
                { title: 'Morning News reads your News feed again', body: 'Its digest is grounded in the headlines you follow, not a generic web search.' }
            ]
        },
        {
            version: '0.1.0-alpha.29',
            date: 'August 6, 2026',
            highlights: [
                { title: 'Every strategy has its own page', body: 'Click a plan\'s name on the Strategy page to see the whole record: verdict, target mix, guardrails, which accounts follow it, and its change history — with questions to ask that fit the plan\'s state.' },
                { title: 'Anjadhe Cloud limits are handled gracefully', body: 'When the cloud asks the app to slow down, email analysis pauses and resumes on its own, and routines quietly try again instead of posting an error to your feed.' },
                { title: 'Logs no longer quote your content', body: 'The app\'s console output used to include snippets of prompts, replies and email subjects. It now describes sizes, not contents.' },
                { title: 'A warmer first briefing', body: 'On a brand-new install, the first Daily Briefing welcomes you and suggests a first step instead of listing everything you don\'t have yet.' }
            ]
        },
        {
            version: '0.1.0-alpha.28',
            date: 'August 6, 2026',
            highlights: [
                { title: 'Anjadhe Cloud', body: 'A model hosted by Anjadhe for Macs that can\'t run one well locally — no account, no key, 1,000 free AI requests a month while it\'s in preview. Nothing you send is stored or used to train models. You\'ll only use it if you add it.' },
                { title: 'Small Macs get a straight answer', body: 'Local models below 32 GB of memory never worked well, so they\'re no longer offered. On a smaller Mac, setup now suggests Anjadhe Cloud, with your own server or API key as the other options.' },
                { title: 'A friendlier welcome', body: 'First-run setup now explains Anjadhe in plain words — what it is, what to ask it, where your data lives — instead of a diagram.' },
                { title: 'Repeating events', body: 'Calendar events can repeat daily, weekly, monthly or yearly, and editing one asks whether you mean that event or the whole series.' },
                { title: 'Ask about anything you\'re looking at', body: 'Tasks, goals, calendar events, open emails and email insights all have an "Ask about this…" button that opens the assistant with that thing as context.' },
                { title: 'Trades from your inbox', body: 'A brokerage confirmation email now carries an "Add to portfolio" button — you review, it never writes itself.' },
                { title: 'Select many tasks at once', body: 'Checkboxes now select rows; delete several with one confirm and one undo. Completing moved into the row menu — and finishing a task earns a little confetti.' }
            ]
        },
        {
            version: '0.1.0-alpha.27',
            date: 'August 5, 2026',
            highlights: [
                { title: 'Your backups are never written in the clear', body: 'A backup used to be copied into iCloud unencrypted and encrypted a moment later, and it stayed that way if anything went wrong in between. Backups are now built and encrypted outside iCloud, and only the encrypted file is put there.' },
                { title: 'Opening the app no longer calls Google', body: 'The typefaces the app is set in were fetched from Google every time it started, before you had connected anything. They now ship inside the app.' },
                { title: 'Model downloads are checked', body: 'The two models most people start with were being installed without verifying the file against a published checksum. Every model in the list is now verified.' },
                { title: 'The privacy policy says exactly where things go', body: 'It now names every service the app can contact, what it sends, and why, and says plainly that your data is never sold.' }
            ]
        },
        {
            version: '0.1.0-alpha.26',
            date: 'August 4, 2026',
            highlights: [
                { title: 'Email AI is its own app', body: 'Find it in the app switcher or Cmd+K. It opens on an Overview of what is coming up and what arrived since you last looked, with one-noun folders (Bills, Receipts, Reservations…) that say exactly what lands in them. Your AI now reads every incoming email instead of pre-filtering by keywords.' },
                { title: 'The Inbox knows who owes whom a reply', body: 'Needs reply and Waiting on them sit at the top of the mail sidebar: threads a person is waiting on you for, and threads quiet three days after you wrote. Reply or archive and they clear themselves; right-click for everything else.' },
                { title: 'Routines can act, and fire when things happen', body: 'Automations and Routines are one thing now. A routine can run on a schedule or the moment an email or file arrives, as a digest or a run that takes action, with each run logged on its page. "Help me set up a routine" walks you through it.' },
                { title: 'News: search, more stories, deeper answers', body: 'A search box filters the current headlines and your saved stories, topics carry 20 stories instead of 10, and "Ask about this" now reads the article itself and can search the web for newer developments.' },
                { title: 'Send Feedback', body: 'Settings has a Send Feedback card that reaches the maker of Anjadhe, and it shows exactly what a send carries before you press Send. Also in the app menu and Cmd+K.' },
                { title: 'The AI reads attachments', body: 'The assistant can open an attached PDF, spreadsheet or document, and a bill whose details live in the attachment gets its due date filled from it.' },
                { title: 'Reload asks first', body: 'Cmd+R says what the AI is in the middle of before throwing it away, and long runs survive restarts. An open window also keeps your Mac from idle-sleeping mid-task.' }
            ]
        },
        {
            version: '0.1.0-alpha.25',
            date: 'August 2, 2026',
            highlights: [
                { title: 'A Plan page for your portfolio', body: 'Plan in the accounts nav shows your strategy: a target mix table with target against actual, what to trim or add in dollars, your guardrails with a pass or fail beside each, and whether you are on plan. Every number is computed by the app, not written by the AI.' },
                { title: 'Focus areas are gone', body: 'Each goal now carries a plain Group label like Health or Work, and the Goals page groups by it. Nothing to create or maintain. Your existing focus areas became group labels automatically.' },
                { title: 'A goal is completed or it is not', body: 'The four working statuses collapsed to one honest pair. Progress lives in the goal\'s tasks, and the weekly AI review tells you whether it is really moving.' },
                { title: 'Scheduled prompts are now routines', body: 'Same feature, a word people actually use. The Routines page is a sortable, filterable, searchable table, and prompts you run by hand moved back into Notes.' },
                { title: 'The assistant finishes what it starts', body: 'Multi-step tasks replan around a step that failed instead of stopping, check the result against what you actually asked for, and always deliver something at the end. It also stopped claiming a task is running when it is not.' },
                { title: 'Calmer detail pages', body: 'Goal, task and routine details are quiet property lists that read as one column, task lists fold away completed rows, and a task with no time says "anytime" instead of a made-up hour.' },
                { title: 'One search in the app', body: 'Notes lost its own search box. Cmd+K is the search, and it now finds your portfolio accounts too.' }
            ]
        },
        {
            version: '0.1.0-alpha.24',
            date: 'July 30, 2026',
            highlights: [
                { title: 'The assistant works while you are away', body: 'Ask for something on a schedule or when an email or file arrives, and it becomes an automation. It runs in the background, notifies you, and waits for your OK when it needs one. The new Automations page shows what ran and what is waiting.' },
                { title: 'Permissions with limits', body: 'A standing permission can carry bounds: so many uses a day, an end date, and exceptions. When a limit runs out the assistant asks instead of acting. Review it all under Standing permissions on the Automations page.' },
                { title: 'It reads your documents', body: 'PDFs including scans, Excel spreadsheets, Word documents, and images. The assistant opens the file and reads what is inside, whether it found it in your folders or on a web page.' },
                { title: 'Recipes and undo', body: 'A task that finishes cleanly can be saved as a recipe and replayed next time. And everything the assistant changes is recorded: Undo this turn in chat, or Undo changes on a finished task, puts things back.' },
                { title: 'Your portfolio reviews itself', body: 'On weekdays, a pre-market note, a midday check and a market-close review appear in your feed, written from your real positions and prices. Edit or turn them off in Prompts.' },
                { title: 'A calmer Portfolio', body: 'Accounts live in a left nav: click one and the page shows its total, chart, holdings and transactions. One simple row per position, and the analysis moved into conversation with the assistant.' },
                { title: 'An app switcher', body: 'The grid button beside the wordmark lists every app. Settings is flatter too, and Cmd+K jumps straight to a specific setting.' },
                { title: 'Edits no longer lost between Macs', body: 'With two Macs open, one could silently discard the other\'s portfolio transactions, note edits, or prompt schedules. They now merge record by record, and scheduled prompts fire once, at their scheduled time.' }
            ]
        },
        {
            version: '0.1.0-alpha.23',
            date: 'July 30, 2026',
            highlights: [
                { title: 'The sidebar is gone, Cmd+K takes you anywhere', body: 'Press Cmd+K for your most-used apps, or type to find any app, note, task, goal or bookmark by name. Every page gained the width back, and a Home button sits in the titlebar whenever you are away from home.' },
                { title: 'Home shows what needs you', body: 'Cards from your apps: overdue tasks, what is due today, unread email insights, what is left on your calendar, your portfolio. A card with nothing to say does not appear, so home empties as you work.' },
                { title: 'Your feed is a digest', body: 'Results are grouped by the prompt that wrote them, newest summarized in place with older ones folded away. Unread / All switches between what needs you and everything.' },
                { title: 'A plan for your portfolio', body: 'Talk to the assistant about what the money is for and the limits you want. Anjadhe then measures your real holdings against the plan and tells you when a trade takes you off it.' },
                { title: 'Clear a whole pile of mail', body: 'Open a bundle and mark it all read, all unread, or archive it. Repeated reminders about the same thing now group into a single insight with a timeline.' },
                { title: 'News has a page of its own', body: 'The news pane on the home page is gone; the News app is where you read. The morning digest is built from your real headlines.' },
                { title: 'Profiles have been removed', body: 'The Work/Personal switcher and its settings page are gone. Everything you have is simply visible in each app.' }
            ]
        },
        {
            version: '0.1.0-alpha.22',
            date: 'July 29, 2026',
            highlights: [
                { title: 'Options in Portfolio', body: 'Track call and put options next to your stocks. Add one with the Stock/Option toggle in the transaction editor, and holdings show the contract with its expiry date.' },
                { title: 'Email search that finds things', body: 'Words now match in any order and inside message bodies, typos are forgiven, and you can narrow with from:, subject: or is:unread.' },
                { title: 'A reading pane in Email', body: 'Mail opens beside the list instead of replacing it, and the page no longer scrolls as a whole. Each pane scrolls on its own.' },
                { title: 'Save a news story', body: 'Open a story and press Save to keep it. Saved stories live under Saved in the News rail and stay there after the headline is gone.' },
                { title: 'Ask the assistant about your mail', body: 'It now searches message bodies, tells you how far back your mail is synced, and can pull older mail from Gmail once you confirm the dates.' },
                { title: 'Calendar shows the right time', body: 'An 8:30 meeting used to draw on the 8:00 line. Timed events now sit at their real start time, with titles on one clean line.' }
            ]
        },
        {
            version: '0.1.0-alpha.21',
            date: 'July 28, 2026',
            highlights: [
                { title: 'News', body: 'A new page with today\'s headlines for topics you pick. Open a story for a summary written on your Mac, or press "Catch me up" for a short digest.' },
                { title: 'Send images to the assistant', body: 'Attach a photo or a screenshot in chat and ask about it. Works with models that can read images. Look for the "Reads images" badge in Settings.' },
                { title: 'Task mode', body: 'The chip on the message box has a new task mode. Your request becomes a step-by-step plan you approve, then the assistant works through it and reports back.' },
                { title: 'Use the assistant from the Terminal', body: 'Turn on Terminal Access in Settings and install the anjadhe command. You can then talk to the same assistant from any terminal window.' },
                { title: 'One switch for web search', body: 'A single switch in Settings now controls all web access. Turn it off and nothing in Anjadhe touches the web.' },
                { title: 'Click a tag in Notes', body: 'Tags on a note are now clickable. One click shows every note with that tag.' }
            ]
        }
    ],

    _chipEl: null,

    init() {
        this._chipEl = document.getElementById('whats-new-chip');
        if (!this._chipEl) return;
        this._chipEl.addEventListener('click', () => this.open());

        const entry = this.RELEASES[0];
        if (!entry) return;

        // Fresh install: everything is new, so nothing is "news".
        if (window.electronStore?.isFirstRun?.()) {
            this._markSeen(entry.version);
            return;
        }
        if (this._seen() === entry.version) return;

        // Only advertise notes that describe the build actually running —
        // never a version the entry was written ahead of.
        this._appVersion().then((v) => {
            if (v && v === entry.version) this._chipEl.style.display = 'inline-flex';
        });
    },

    open() {
        const entry = this.RELEASES[0];
        if (!entry) return;
        this._markSeen(entry.version);
        if (this._chipEl) this._chipEl.style.display = 'none';

        const esc = (s) => UIUtils.escapeHtml(s);
        const modal = Modal.create({
            title: 'What&rsquo;s new in Anjadhe',
            className: 'modal-wide whats-new-modal',
            content: `
                <p class="whats-new-meta">Version ${esc(entry.version)} &middot; ${esc(entry.date)}</p>
                <ul class="whats-new-list">
                    ${entry.highlights.map(h => `
                    <li class="whats-new-item">
                        <span class="whats-new-item-title">${esc(h.title)}</span>
                        <span class="whats-new-item-body">${esc(h.body)}</span>
                    </li>`).join('')}
                </ul>
                <p class="whats-new-foot">
                    <a href="#" class="whats-new-changelog-link">Earlier releases</a> &middot;
                    <a href="#" class="whats-new-contact-link">Contact the founder</a>
                </p>`,
            buttons: [{ text: 'Close', className: 'primary-btn' }]
        });
        modal.body.querySelector('.whats-new-changelog-link')?.addEventListener('click', (e) => {
            e.preventDefault();
            modal.close();
            this.openChangelog();
        });
        modal.body.querySelector('.whats-new-contact-link')?.addEventListener('click', (e) => {
            e.preventDefault();
            window.electronAuth?.openExternal?.(this.FOUNDER_MAILTO);
        });
    },

    // The public changelog, every release newest first. Fetched on demand
    // from the website; falls back to this file's RELEASES when offline.
    async openChangelog() {
        const esc = (s) => UIUtils.escapeHtml(String(s ?? ''));
        const modal = Modal.create({
            title: 'Changelog',
            className: 'modal-wide whats-new-modal changelog-modal',
            content: `<p class="whats-new-meta">Loading the release list from anjadhe.ai&hellip;</p>`,
            buttons: [{ text: 'Close', className: 'primary-btn' }]
        });
        const releases = await this.fetchReleases();
        if (!modal.element.open) return; // closed while loading

        const current = await this._appVersion();
        let html;
        if (releases) {
            html = releases.map(r => `
                <section class="changelog-release">
                    <h4 class="changelog-release-head">
                        <span class="changelog-release-version">${esc(r.tag || ('v' + r.version))}</span>
                        ${r.version === current ? '<span class="changelog-release-badge">This Mac</span>' : ''}
                        <span class="changelog-release-date">${esc(this._humanDate(r.date))}</span>
                    </h4>
                    <div class="changelog-release-body">${this._renderNotes(r.body || r.summary || '')}</div>
                </section>`).join('');
        } else {
            html = `<p class="whats-new-meta">Couldn&rsquo;t reach anjadhe.ai, so this is the shorter list this app carries with it.</p>`
                + this.RELEASES.map(r => `
                <section class="changelog-release">
                    <h4 class="changelog-release-head">
                        <span class="changelog-release-version">v${esc(r.version)}</span>
                        ${r.version === current ? '<span class="changelog-release-badge">This Mac</span>' : ''}
                        <span class="changelog-release-date">${esc(r.date)}</span>
                    </h4>
                    <ul class="changelog-release-body">${r.highlights.map(h => `<li><strong>${esc(h.title)}.</strong> ${esc(h.body)}</li>`).join('')}</ul>
                </section>`).join('');
        }
        modal.body.innerHTML = html + `
            <p class="whats-new-foot">
                <a href="#" class="whats-new-changelog-link">Open anjadhe.ai/changelog</a> &middot;
                <a href="#" class="whats-new-contact-link">Contact the founder</a>
            </p>`;
        modal.body.querySelector('.whats-new-changelog-link')?.addEventListener('click', (e) => {
            e.preventDefault();
            window.electronAuth?.openExternal?.(this.CHANGELOG_PAGE);
        });
        modal.body.querySelector('.whats-new-contact-link')?.addEventListener('click', (e) => {
            e.preventDefault();
            window.electronAuth?.openExternal?.(this.FOUNDER_MAILTO);
        });
    },

    // The public release list (newest first), or null when offline/blocked.
    // Fetched only when a user opens a view that shows it; nothing about
    // the user travels with the request.
    async fetchReleases() {
        try {
            const ctrl = new AbortController();
            const t = setTimeout(() => ctrl.abort(), 8000);
            const res = await fetch(this.CHANGELOG_URL, { signal: ctrl.signal, cache: 'no-store' });
            clearTimeout(t);
            if (res.ok) {
                const data = await res.json();
                if (Array.isArray(data?.releases) && data.releases.length) return data.releases;
            }
        } catch { /* offline or blocked */ }
        return null;
    },

    // One release's notes — the update nudge's "what's in this release"
    // door, so the user can read before choosing to restart. Looks the
    // version up in the public changelog; when that can't be reached the
    // modal says so and offers the changelog page in the browser instead
    // (this app's own RELEASES list can't describe a version newer than
    // itself).
    async openReleaseNotes(version) {
        const esc = (s) => UIUtils.escapeHtml(String(s ?? ''));
        const v = String(version || '').replace(/^v/, '');
        const modal = Modal.create({
            title: `What\u2019s in v${esc(v)}`,
            className: 'modal-wide whats-new-modal changelog-modal',
            content: `<p class="whats-new-meta">Loading the release notes from anjadhe.ai&hellip;</p>`,
            buttons: [{ text: 'Close', className: 'primary-btn' }]
        });
        const releases = await this.fetchReleases();
        if (!modal.element.open) return;
        const rel = releases?.find(r => String(r.version || '').replace(/^v/, '') === v
            || String(r.tag || '').replace(/^v/, '') === v);
        let html;
        if (rel) {
            html = `
                <section class="changelog-release">
                    <h4 class="changelog-release-head">
                        <span class="changelog-release-version">${esc(rel.tag || ('v' + rel.version))}</span>
                        <span class="changelog-release-date">${esc(this._humanDate(rel.date))}</span>
                    </h4>
                    <div class="changelog-release-body">${this._renderNotes(rel.body || rel.summary || '')}</div>
                </section>`;
        } else if (releases) {
            html = `<p class="whats-new-meta">anjadhe.ai doesn&rsquo;t list v${esc(v)} yet. The full changelog is at the link below.</p>`;
        } else {
            html = `<p class="whats-new-meta">Couldn&rsquo;t reach anjadhe.ai. The release notes for v${esc(v)} are on the changelog page below.</p>`;
        }
        const page = (rel?.url && /^https:\/\/anjadhe\.ai\//.test(rel.url)) ? rel.url : this.CHANGELOG_PAGE;
        modal.body.innerHTML = html + `
            <p class="whats-new-foot">
                <a href="#" class="whats-new-changelog-link">Open anjadhe.ai/changelog</a>
            </p>`;
        modal.body.querySelector('.whats-new-changelog-link')?.addEventListener('click', (e) => {
            e.preventDefault();
            window.electronAuth?.openExternal?.(page);
        });
    },

    // Release notes are a fixed, authored dialect of markdown (RELEASING.md
    // step 2: "## Added/Changed/Fixed" + bullets + bold/code), so a tiny
    // renderer is enough and safer than a general one: everything is
    // escaped first, then only those few marks are turned into tags.
    _renderNotes(md) {
        const esc = (s) => UIUtils.escapeHtml(s);
        const inline = (s) => esc(s)
            .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
            .replace(/`([^`]+)`/g, '<code>$1</code>');
        const out = [];
        let list = null;
        let para = [];
        const flushPara = () => { if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; } };
        const flushList = () => { if (list) { out.push(`<ul>${list.join('')}</ul>`); list = null; } };
        for (const raw of String(md).split('\n')) {
            const line = raw.trimEnd();
            if (/^##\s+/.test(line)) { flushPara(); flushList(); out.push(`<h5>${esc(line.replace(/^##\s+/, ''))}</h5>`); continue; }
            if (/^#\s+/.test(line)) continue; // the "# vX" heading, if any
            if (/^[-*]\s+/.test(line)) { flushPara(); list = list || []; list.push(`<li>${inline(line.replace(/^[-*]\s+/, ''))}</li>`); continue; }
            if (/^\s+\S/.test(raw) && list) { list[list.length - 1] = list[list.length - 1].replace(/<\/li>$/, ' ' + inline(line.trim()) + '</li>'); continue; }
            if (!line) { flushPara(); flushList(); continue; }
            para.push(line);
        }
        flushPara(); flushList();
        return out.join('');
    },

    _humanDate(iso) {
        const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
        if (!m) return iso || '';
        const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
        return d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
    },

    _appVersion() {
        return window.electronSystem?.getInfo?.().then(i => i?.appVersion || null).catch(() => null)
            || Promise.resolve(null);
    },

    _seen() {
        try { return localStorage.getItem(this.SEEN_KEY); } catch { return null; }
    },

    _markSeen(version) {
        try { localStorage.setItem(this.SEEN_KEY, version); } catch { /* storage unavailable */ }
    }
};
