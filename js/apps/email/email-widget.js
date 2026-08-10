/**
 * Email on home — unread AI insights, and nothing else.
 *
 * Applying the widget rule to email is what makes it useful: the card shows
 * the renewals, bills and deadlines the assistant pulled out and you have
 * not looked at yet. It does NOT show an inbox count. Nobody opens an app
 * to find out they have 2,481 emails, and a number that never reaches zero
 * is a number people learn to ignore.
 *
 * Reading an insight (here or in the app) marks it read, so this card
 * empties as you work through it and then disappears. See js/core/widgets.js.
 *
 * Load note: EmailApp is not initialised at startup — it loads when the app
 * is first opened. So the first home paint of a session usually has nothing
 * in memory. Rather than block home on a SQLite read, the widget kicks a
 * background load once and repaints when it lands. That kick is also the
 * app's whole email bootstrap (see kickLoad) — it moved here from
 * PromptFeed when insights left the feed.
 */
(function () {
    const MAX_ROWS = 4;

    let loading = false;
    let attempts = 0;
    const MAX_ATTEMPTS = 3;

    /**
     * Is there email to load at all? Read straight from the blob, which is
     * synchronous and always current — EmailApp.accounts is empty both when
     * nothing is connected AND when it simply has not loaded yet, so it
     * cannot answer this on its own.
     *
     * Asking the blob instead of latching a "tried once" flag is what makes
     * connect-an-account-then-go-home work: the first home paint of a session
     * happens before any load, and a one-shot flag would leave the card dead
     * for the rest of the session.
     */
    function accountsExist() {
        const data = StorageManager.get('email');
        return Array.isArray(data?.accounts) && data.accounts.length > 0;
    }

    /**
     * Has loadData actually run? Ask the flag it sets, not `accounts.length`:
     * AccountsManager.init writes connected accounts into EmailApp.accounts at
     * startup as a derived view, so that array is non-empty before any mail is
     * loaded — and this card, believing itself loaded, never kicked the load
     * that is the app's whole email bootstrap.
     */
    function loaded() {
        return EmailApp._dataLoaded === true;
    }

    /**
     * Load mail and start the background pipeline.
     *
     * This is the app's email bootstrap, not just a widget concern: without
     * it, a session where the Email app is never opened does no syncing and
     * runs no insight analysis, so nothing new ever reaches this card. It
     * used to live in PromptFeed._ensureEmailData, feeding the feed's
     * insight cards; those cards moved out of the feed on 2026-07-29 and
     * this came with them. Every call below no-ops without connected
     * accounts, and EmailApp.init redoes them harmlessly on first open.
     */
    async function kickLoad() {
        if (loading || attempts >= MAX_ATTEMPTS) return;
        loading = true;
        attempts++;
        try {
            if (EmailApp._initInFlight) {
                // Routed straight into the Email app — its own init is
                // already loading; piggyback rather than double-load.
                await EmailApp._initInFlight;
            } else {
                // loadData dedupes in-flight callers, so this cannot race
                // the user opening the Email app at the same moment.
                if (!EmailApp.emails.length) await EmailApp.loadData();
                EmailApp.startSmartSync();
                EmailApp.setupSyncLifecycle();
                EmailApp.deltaSync();
                EmailApp.requeueMissedAnalyses();
                EmailApp.drainAnalysisQueue();
            }
        } catch (e) {
            console.warn('[email widget] background load failed:', e);
        } finally {
            loading = false;
            Widgets.refresh();
        }
    }

    /** "renews Aug 3" / "due yesterday" — why this insight matters now. */
    function whenLabel(analysis) {
        const iso = EmailApp._matterDate?.(analysis);
        if (!iso) return '';
        const today = new Date(); today.setHours(0, 0, 0, 0);
        const then = new Date(iso + 'T00:00:00');
        if (isNaN(then)) return '';
        const days = Math.round((then - today) / 86400000);
        if (days === 0) return 'today';
        if (days === 1) return 'tomorrow';
        if (days === -1) return 'yesterday';
        if (days < 0) return `${Math.abs(days)} days ago`;
        if (days <= 14) return `in ${days} days`;
        return then.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    }

    Widgets.register('email-insights', {
        kind: 'attention',
        title: 'Email needs you',
        // The card's own door is Email Insights, where these are read.
        app: 'fyi',
        order: 20,                      // needs a decision, below overdue
        load() {
            if (typeof EmailApp === 'undefined') return null;
            if (!EmailApp.aiInsightsEnabled) return null;
            if (!accountsExist()) return null;
            if (!loaded()) { kickLoad(); return null; }

            const analyses = EmailApp.getProfileAnalyses();
            // This card is DELIBERATELY narrower than the page it opens.
            //
            // Until 2026-08-03 the two matched by necessity — the page could
            // not show a tasked insight, so offering one here would have been
            // a row that opened onto nothing. The page now shows everything,
            // which frees this to be what a home card should be: an attention
            // surface. An insight that already became a task is already
            // asking for attention, on the Tasks card a few rows up; saying
            // it twice on one screen is the nagging home is meant to avoid.
            // The constraint that remains is one-directional — every row here
            // must be openable there — and a subset always satisfies it.
            const tasked = new Set(
                ((StorageManager.get('schedule') || {}).scheduleItems || [])
                    .filter(i => i.sourceEmailId)
                    .map(i => i.sourceEmailId)
            );
            // The page's retention window applies HERE too. Analyses live
            // forever (a Re-analyze over old mail mints insights for it),
            // but FyiPage._items only renders the last RETENTION_DAYS of
            // mail — an unwindowed card offered months-old "unread"
            // insights whose Read button opened onto a page that did not
            // contain them. Same for an insight whose message has left the
            // local table: the page skips it, so this card must too.
            const cutoff = Date.now()
                - ((typeof FyiPage !== 'undefined' && FyiPage.RETENTION_DAYS) || 90) * 86400000;
            const unread = Object.entries(analyses)
                // rolledUp: folded matter members aren't rows on the page
                // either — only the matter head is readable.
                .filter(([id, a]) => a && !a.readAt && !a.rolledUp && !EmailApp.representedByTask(id, a, tasked))
                .map(([id, a]) => ({ id, a, email: EmailApp.emailById(id) }))
                .filter(({ email }) => email && EmailApp._emailTime(email) >= cutoff);
            if (!unread.length) return null;

            // Action-required first, then high priority, then the rest —
            // "your registration expires Friday" outranks "your statement is
            // ready" no matter which arrived later.
            const rank = ({ a }) => (a.actionRequired ? 0 : 2) + (a.priority === 'high' ? 0 : 1);
            unread.sort((x, y) => rank(x) - rank(y));

            const shown = unread.slice(0, MAX_ROWS);
            return {
                count: unread.length,
                body: Widgets.rows(shown.map(({ id, a, email }) => {
                    const when = whenLabel(a);
                    return {
                        text: UIUtils.humanizeIsoDates(a.summary || email?.subject || '(no subject)'),
                        // The date is the reason it is on this card; the type
                        // is context. Sender is deliberately absent — the
                        // summary already says what it is.
                        sub: when || (a.type && a.type !== 'general' ? a.type : ''),
                        flag: a.actionRequired ? 'Action' : '',
                        actions: [
                            { label: 'Read', action: 'open', id, title: 'Open this insight' },
                            { label: 'Dismiss', action: 'dismiss', id, title: 'Mark read without opening' }
                        ]
                    };
                })),
                footer: Widgets.more(unread.length - shown.length)
            };
        },
        onAction(action, data) {
            if (!data.id) return;
            if (action === 'open') {
                // Insights are read in Actions › FYI since 2026-08-02; the
                // Email app has no insights page to land on any more. The
                // flag is consumed inside FyiPage.init, after it restores its
                // saved selection — a plain assignment before openApp would
                // be overwritten by that restore.
                FyiPage.openTo(data.id);
                return;
            }
            if (action === 'dismiss') {
                EmailApp.markAnalysisRead(data.id, true);
                Widgets.refresh();
            }
        }
    });
})();
