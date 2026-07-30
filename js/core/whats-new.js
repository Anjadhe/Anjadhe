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
