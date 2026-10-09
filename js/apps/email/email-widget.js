/**
 * EmailHome — the email bootstrap and where reading stands.
 *
 * Until 2026-10-07 this was also the "Needs a look" home widget (unread
 * insights); what mail needs of the person is the folder cards on Now now
 * (docs/MATTERS.md §17), and this file keeps the load, the progress and the
 * one wording of the status line.
 *
 * EmailApp is a headless service. Now starts it in the background through
 * kickLoad; chat tools can load its cache independently on a cold start.
 */
(function () {
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
        if (Array.isArray(data?.accounts) && data.accounts.length > 0) return true;
        // Texts are a source too (2026-09-10): a Mac with no Gmail but the
        // iMessage switch on still has insights to show.
        return typeof IMessageSource !== 'undefined' && IMessageSource.enabled();
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

    /** Start the shared email service without waiting for a screen to open. */
    async function kickLoad() {
        if (loading || attempts >= MAX_ATTEMPTS) return;
        loading = true;
        attempts++;
        try {
            await EmailApp.init();
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

    /**
     * Where the first read of a mailbox stands, for Simple home's progress
     * line (2026-10-01). A friend connected Gmail and saw nothing change:
     * the analysis drains ~2.5 s per email on nenva cloud and nothing on
     * the default home said it was happening. Counts only — no mail text.
     */
    function progress() {
        if (typeof EmailApp === 'undefined' || !EmailApp.aiInsightsEnabled || !accountsExist()) {
            return { connected: false };
        }
        if (!loaded()) { kickLoad(); return { connected: true, loading: true }; }
        // The drain's own two gates (drainAnalysisQueue), so a line that
        // says "reading" is never shown over a queue that cannot move.
        const blocked = (typeof AgentService === 'undefined' || !AgentService.model) ? 'model'
            : (typeof CloudPrivacy !== 'undefined' && !CloudPrivacy.allowsFor('email', 'email')) ? 'privacy'
            : null;
        return {
            connected: true,
            loading: EmailApp.isSyncing && !EmailApp.emails.length,
            // Read but not yet filed into a folder counts as still reading (§17).
            queued: EmailApp.pendingAnalysisIds.length + (typeof Matters !== 'undefined' && Matters.retryCount ? Matters.retryCount() : 0),
            blocked
        };
    }

    /**
     * The ONE wording of where reading stands (2026-10-01), shared by Simple
     * home's "From your email" and the Insights page's status strip, so the
     * two can never tell different stories about the same queue. `p` is
     * progress(). null when there is nothing to say. `fix` names the
     * Settings category that unblocks a stuck queue.
     */
    function statusLine(p) {
        if (!p?.connected) return null;
        if (p.blocked === 'model') return {
            kind: 'blocked', fix: 'ai',
            title: 'Your email is connected. Choose an AI model so I can read it.',
            meta: 'Settings \u203a Model'
        };
        if (p.blocked === 'privacy' && (p.loading || p.queued > 0)) return {
            kind: 'blocked', fix: 'privacy',
            title: 'Your email is connected, but background reading is off for it.',
            meta: 'Turn it on in Settings \u203a Privacy'
        };
        if (p.loading) return {
            kind: 'reading', title: 'Getting your recent email\u2026',
            meta: 'Bills, deadlines and bookings that need you will show up here.'
        };
        if (p.queued > 0) return {
            kind: 'reading', title: `Reading your email \u00b7 ${p.queued} to go`,
            meta: 'Bills, deadlines and bookings that need you will show up here.'
        };
        return null;
    }

    /** The folder an insight sits in, as the Insights nav names it ("Receipts",
     *  not the stored id "receipt"); nothing for the catch-all. */
    function typeLabel(analysis) {
        const type = analysis?.type;
        if (!type || type === 'general') return '';
        return EmailApp.INSIGHT_TYPE_LABELS?.[type] || type;
    }

    // Read by SimpleExperience (js/core/simple-experience.js). Bundled here
    // because this load is the app's email bootstrap. The "Needs a look"
    // widget and `unreadInsights` went 2026-10-07 (docs/MATTERS.md §17): what
    // mail needs of the person is the folder cards on Now.
    window.EmailHome = { progress, statusLine, whenLabel, typeLabel, loaded, accountsExist, kickLoad };
})();
