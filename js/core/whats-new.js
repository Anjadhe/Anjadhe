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
 */
const WhatsNew = {
    SEEN_KEY: 'anjadhe_whats_new_seen',

    // Newest first. Keep each body to one or two plain sentences.
    RELEASES: [
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
        Modal.create({
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
                <p class="whats-new-foot">The complete list of changes is in the
                    <a href="https://github.com/Anjadhe/Anjadhe/releases" target="_blank" rel="noopener">release notes</a>.</p>`,
            buttons: [{ text: 'Close', className: 'primary-btn' }]
        });
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
