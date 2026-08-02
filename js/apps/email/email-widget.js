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

    /** Accounts land in memory only once loadData has actually run. */
    function loaded() {
        return Array.isArray(EmailApp.accounts) && EmailApp.accounts.length > 0;
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
                EmailApp.setupIdleDetection();
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
        app: 'email',
        order: 20,                      // needs a decision, below overdue
        load() {
            if (typeof EmailApp === 'undefined') return null;
            if (!EmailApp.aiInsightsEnabled) return null;
            if (!accountsExist()) return null;
            if (!loaded()) { kickLoad(); return null; }

            const analyses = EmailApp.getProfileAnalyses();
            const unread = Object.entries(analyses)
                // rolledUp: folded matter members aren't rows in the app's
                // insights list either — only the matter head is readable.
                .filter(([, a]) => a && !a.readAt && !a.rolledUp)
                .map(([id, a]) => ({ id, a }));
            if (!unread.length) return null;

            // Action-required first, then high priority, then the rest —
            // "your registration expires Friday" outranks "your statement is
            // ready" no matter which arrived later.
            const rank = ({ a }) => (a.actionRequired ? 0 : 2) + (a.priority === 'high' ? 0 : 1);
            unread.sort((x, y) => rank(x) - rank(y));

            const shown = unread.slice(0, MAX_ROWS);
            return {
                count: unread.length,
                body: Widgets.rows(shown.map(({ id, a }) => {
                    const email = EmailApp.emailById(id);
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
                // Consume-once flag honored inside EmailApp.init. Calling
                // showInsightDetail after openApp would lose the race with
                // init's own view logic.
                EmailApp._openToInsightDetail = data.id;
                AppManager.openApp('email');
                return;
            }
            if (action === 'dismiss') {
                EmailApp.markAnalysisRead(data.id, true);
                Widgets.refresh();
            }
        }
    });
})();
