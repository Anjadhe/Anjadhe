/**
 * The built-in sources, registered on Sources (2026-10-06, docs/VISION.md
 * "Sources"): Gmail, Google Calendar, Apple Calendar, Apple Reminders, texts
 * (iMessage) and Files (the Documents library). Each adapter is a thin
 * description over the machinery that already exists (AccountsManager,
 * AppleImport, IMessageSource, electronLibrary); nothing here is a second
 * copy of it. The connector pages are SimpleSettings' builders.
 *
 * Still to come on this registry: Apple Notes as an index source (the
 * import that copied notes into the notes blob is retired), write-back for
 * Apple Reminders, and the on-demand (reference) sources.
 */
(() => {
    if (typeof Sources === 'undefined') return;
    const google = (service) => () => {
        if (typeof AccountsManager === 'undefined') return { on: false, value: 'Not available' };
        const all = AccountsManager.getAll();
        const on = all.filter(a => !AccountsManager.isLocallyDisconnected(a.email) && AccountsManager.isServiceEnabled(a.email, service));
        if (on.length) return { on: true, value: on.length === 1 ? on[0].email : `${on.length} accounts`, accounts: on.map(a => a.email) };
        return { on: false, value: all.length ? 'Off' : 'Not connected' };
    };

    Sources.register({
        id: 'gmail', label: 'Gmail', icon: 'mail', words: 'google email mail inbox', kind: 'mail', mode: 'mirror', google: 'mail',
        reads: 'Your recent mail, synced from Google to this Mac and read here: what needs you lands on Now as folders (bills, appointments, orders, replies).',
        privacy: 'email', feeds: ['matters', 'commitments', 'memory'],
        status: google('mail'), page: (S, c) => S._googleHtml(c)
    });
    Sources.register({
        id: 'gcal', label: 'Google Calendar', icon: 'calendar', words: 'google events meetings', kind: 'calendar', mode: 'mirror', writesBack: true, google: 'calendar',
        reads: 'Your Google events, shown in Today and Coming up; events you add or change in nenva are written to Google Calendar.',
        privacy: 'email', feeds: ['calendar', 'matters'],
        status: google('calendar'), page: (S, c) => S._googleHtml(c)
    });
    Sources.register({
        id: 'applecal', label: 'Apple Calendar', icon: 'calendar', words: 'icloud events meetings', kind: 'calendar', mode: 'mirror', writesBack: true, apple: 'events',
        reads: 'This Mac’s iCloud and local calendars, mirrored into nenva and kept current; events you add or change here are written to Apple Calendar.',
        privacy: 'notes', feeds: ['calendar', 'matters'],
        status: () => {
            if (typeof AppleImport === 'undefined') return { on: false, value: 'Not available' };
            const on = AppleImport.eventsEnabled();
            const k = (AppleImport.state().eventsCounts) || {};
            return { on, value: on ? 'On' : 'Off', detail: on && k.events ? `${k.events} events from ${k.calendars || 0} calendars` : '' };
        },
        page: (S, c) => S._appleHtml(c)
    });
    Sources.register({
        id: 'applereminders', label: 'Apple Reminders', icon: 'check', words: 'icloud tasks to-do todo lists', kind: 'tasks', mode: 'mirror', writesBack: true, apple: 'reminders',
        reads: 'This Mac’s iCloud reminders, brought in as commitments. Reminders stays the truth: what you do here (done, dropped, a new date or title, removed) is written back to it.',
        privacy: 'notes', feeds: ['commitments'],
        status: () => {
            if (typeof AppleImport === 'undefined') return { on: false, value: 'Not available' };
            const on = AppleImport.enabled();
            const k = (AppleImport.state().counts) || {};
            return { on, value: on ? 'On' : 'Off', detail: on && (k.created || k.updated) ? `${k.created || 0} added, ${k.updated || 0} updated` : '' };
        },
        page: (S, c) => S._appleHtml(c)
    });
    Sources.register({
        id: 'texts', label: 'Texts', icon: 'text', words: 'imessage sms messages texts', kind: 'texts', mode: 'mirror',
        reads: 'The texts that arrive in Messages on this Mac, each conversation read once it goes quiet: appointment reminders, deliveries, bills and plans made over text land in folders like mail does.',
        privacy: 'messages', feeds: ['matters', 'commitments'],
        consent: 'Reading Messages needs Full Disk Access, which covers the whole Messages database; that is why this is off until you turn it on, and why your texts stay on this Mac unless you also allow your AI to read them below.',
        status: () => {
            if (typeof IMessageSource === 'undefined') return { on: false, value: 'Not available' };
            const st = IMessageSource.state();
            return { on: !!st.enabled, value: st.enabled ? (st.lastError ? 'Needs attention' : 'On') : 'Off', detail: st.enabled && st.lastAt ? `${st.conversations} conversation${st.conversations === 1 ? '' : 's'} read` : '' };
        },
        page: (S, c) => S._textsHtml(c)
    });
    Sources.register({
        id: 'files', label: 'Files', icon: 'file', words: 'documents pdf library folder scans spreadsheets', kind: 'files', mode: 'mirror',
        reads: 'The documents you put in your nenva library folder (PDFs, scans, spreadsheets, text), read and indexed on this Mac so the assistant can find and quote them.',
        privacy: 'browse', feeds: ['index'],
        status: () => {
            if (!window.electronLibrary || typeof ReaderApp === 'undefined') return { on: false, value: 'Not available' };
            const st = ReaderApp._status || null;
            return { on: true, value: st && st.docs ? `${st.docs} document${st.docs === 1 ? '' : 's'}` : 'On', detail: st && st.dir ? st.dir : '' };
        },
        page: (S, c) => S._filesHtml(c)
    });
})();
