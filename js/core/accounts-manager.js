/**
 * AccountsManager — single source of truth for connected third-party accounts
 * (Google for now, Apple/Outlook later). Modeled after macOS Internet Accounts:
 * one OAuth grant per account, then the user toggles which services to sync.
 *
 * Accounts are GLOBAL — not per-profile — because a connected Google account
 * is a system-level concept like a keychain entry. Per-profile filtering of
 * the synced data (emails, events) still happens at the app level.
 *
 * Account schema:
 *   {
 *     id: 'acc_xxx',
 *     provider: 'google',
 *     email: 'user@gmail.com',
 *     displayName: 'User Name',          // from userinfo (optional)
 *     services: { mail: true, calendar: true },  // enabled per service
 *     connectedAt: ISO string,
 *     lastSyncAt: ISO string | null
 *   }
 *
 * EmailApp.accounts and CalendarApp.accounts are DERIVED views — they get
 * populated from AccountsManager by syncToApps() based on which services are
 * enabled. The per-app sidebars still read from those local arrays so we
 * don't have to rewrite their rendering code.
 */

const AccountsManager = {
    _storageKey: 'accounts',
    _cache: null,
    _migrated: false,

    _load() {
        if (this._cache) return this._cache;
        const data = StorageManager.get(this._storageKey);
        if (data && Array.isArray(data.accounts)) {
            this._cache = data;
        } else {
            this._cache = { accounts: [], migratedFromLegacy: false };
        }
        return this._cache;
    },

    _save() {
        if (!this._cache) return;
        StorageManager.set(this._storageKey, this._cache);
    },

    /**
     * Initialize. Call on app startup AFTER EmailApp.loadData() and
     * CalendarApp.loadData() have run, so we can migrate any legacy accounts.
     */
    init() {
        this._load();
        this._migrateFromLegacyApps();
        this.syncToApps();
    },

    /**
     * One-time migration: read legacy account lists straight from StorageManager
     * (so we don't depend on EmailApp/CalendarApp being initialized — they're
     * lazy-init'd when their views are opened). Idempotent — a flag in our
     * own store prevents re-migration on subsequent loads.
     */
    _migrateFromLegacyApps() {
        const data = this._load();
        if (data.migratedFromLegacy) return;

        const byEmail = new Map();

        const newId = () => 'acc_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
        const upsert = (email, service, connectedAt) => {
            if (!email) return;
            const entry = byEmail.get(email) || {
                id: newId(),
                provider: 'google',
                email,
                displayName: email,
                services: { mail: false, calendar: false },
                connectedAt: connectedAt || new Date().toISOString(),
                lastSyncAt: null
            };
            entry.services[service] = true;
            byEmail.set(email, entry);
        };

        // Source 1: legacy email app store. We collect across ALL profiles
        // so accounts that were created under one profile and then orphaned
        // by a profile switch still get picked up.
        const emailData = StorageManager.get('email');
        const emailAccounts = emailData?.accounts || [];
        for (const a of emailAccounts) upsert(a.email, 'mail', a.connectedAt);

        // Source 2: legacy calendar app store
        const calData = StorageManager.get('calendar');
        const calAccounts = calData?.accounts || [];
        for (const a of calAccounts) upsert(a.email, 'calendar', a.connectedAt);

        if (byEmail.size > 0) {
            for (const [email, entry] of byEmail) {
                const existing = data.accounts.find(a => a.email === email);
                if (existing) {
                    existing.services.mail = existing.services.mail || entry.services.mail;
                    existing.services.calendar = existing.services.calendar || entry.services.calendar;
                } else {
                    data.accounts.push(entry);
                }
            }
            console.log(`[accounts] Migrated ${byEmail.size} legacy account(s) into unified store`);
        }

        data.migratedFromLegacy = true;
        this._save();
    },

    /**
     * Push the current AccountsManager state into the legacy email/calendar
     * storage so per-app sidebars and sync routines see a consistent view.
     * Each app's accounts array contains exactly the accounts that have
     * its service enabled.
     *
     * We write through both the in-memory app object (if it's loaded) AND
     * StorageManager (so the next loadData picks it up).
     */
    syncToApps() {
        const data = this._load();
        // Only accounts that hold OAuth tokens ON THIS MAC reach the apps.
        // The account list syncs between Macs but tokens are per-machine
        // (keychain), so on a second Mac a synced account would otherwise
        // show up in Email/Calendar and fail every fetch. It stays visible
        // in Settings › Connected Accounts (which reads getAll) with a
        // "not connected on this Mac" state instead.
        const accounts = data.accounts.filter(a =>
            this.hasLocalTokens(a.email, 'mail') || this.hasLocalTokens(a.email, 'calendar'));
        // Build legacy-shaped account entries for each service
        const mailAccounts = accounts.filter(a => a.services?.mail && this.hasLocalTokens(a.email, 'mail')).map(a => ({
            id: a.id + '_email',
            email: a.email,
            provider: 'gmail',
            connectedAt: a.connectedAt
        }));
        const calAccounts = accounts.filter(a => a.services?.calendar && this.hasLocalTokens(a.email, 'calendar')).map(a => ({
            id: a.id + '_cal',
            email: a.email,
            provider: 'google',
            connectedAt: a.connectedAt
        }));

        // Write through to the email app store (preserve other email data)
        const emailData = StorageManager.get('email') || {};
        StorageManager.set('email', { ...emailData, accounts: mailAccounts });
        if (typeof EmailApp !== 'undefined' && Array.isArray(EmailApp.accounts)) {
            EmailApp.accounts.length = 0;
            EmailApp.accounts.push(...mailAccounts);
        }

        // Write through to the calendar app store
        const calData = StorageManager.get('calendar') || {};
        StorageManager.set('calendar', { ...calData, accounts: calAccounts });
        if (typeof CalendarApp !== 'undefined' && Array.isArray(CalendarApp.accounts)) {
            CalendarApp.accounts.length = 0;
            CalendarApp.accounts.push(...calAccounts);
        }
    },

    // --- Per-Mac token status ---

    _tokenStatus: null,

    /**
     * Does THIS Mac hold OAuth tokens for the account+service? Token
     * presence is per-machine (keychain-encrypted, never synced), while the
     * account list syncs — so a synced account can exist without being
     * usable here. Cached for the session; invalidated on connect/remove.
     * Fails open (true) when the bridge is missing (tests, older preload)
     * so filtering never hides accounts by accident.
     */
    hasLocalTokens(email, service) {
        if (!window.electronAccounts?.tokenStatus) return true;
        // Unknown email (e.g. connected after the cache was built) → rebuild.
        if (!this._tokenStatus || !(email in this._tokenStatus)) {
            const emails = this._load().accounts.map(a => a.email);
            if (!emails.includes(email)) emails.push(email);
            try {
                this._tokenStatus = window.electronAccounts.tokenStatus(emails) || {};
            } catch (e) {
                console.warn('[accounts] token status check failed:', e?.message);
                return true;
            }
        }
        return !!this._tokenStatus[email]?.[service];
    },

    /** True when the account has no usable tokens on this Mac at all. */
    isLocallyDisconnected(email) {
        return !this.hasLocalTokens(email, 'mail') && !this.hasLocalTokens(email, 'calendar');
    },

    _invalidateTokenStatus() {
        this._tokenStatus = null;
    },

    // --- Public read API ---

    getAll() {
        return this._load().accounts.slice();
    },

    get(id) {
        return this._load().accounts.find(a => a.id === id) || null;
    },

    getByEmail(email) {
        return this._load().accounts.find(a => a.email === email) || null;
    },

    isServiceEnabled(email, service) {
        const a = this.getByEmail(email);
        return !!a?.services?.[service];
    },

    /**
     * Pre-connect walkthrough shown before every Google OAuth launch.
     * Anjadhe's OAuth verification is still under Google review, so users
     * hit an "unverified app" interstitial; this modal tells them the
     * warning is expected and how to get through it. Resolves true to
     * proceed with sign-in, false if the user cancels. Remove the
     * warning paragraph (or the whole modal) once verification is granted.
     */
    confirmGoogleConnect() {
        if (typeof Modal === 'undefined') return Promise.resolve(true);
        return new Promise(resolve => {
            let proceed = false;
            const modal = Modal.create({
                title: 'Connecting your Google account',
                className: 'google-connect-notice-modal',
                content: `
                    <div class="google-connect-notice">
                        <p>Your web browser will open to Google's sign-in page.
                        Anjadhe is currently going through Google's app verification
                        review, so Google may show a <strong>&ldquo;Google hasn&rsquo;t
                        verified this app&rdquo;</strong> warning. That screen is a
                        normal part of the review period &mdash; here is how to
                        connect through it:</p>
                        <ol class="google-connect-steps">
                            <li>Choose the Google account you want to connect.</li>
                            <li>If the unverified-app warning appears, click
                                <strong>Advanced</strong>, then
                                <strong>Go to Anjadhe (unsafe)</strong>.</li>
                            <li>On the access screen, tick the checkboxes for
                                Gmail and Calendar, then click
                                <strong>Continue</strong>.</li>
                            <li>When Google confirms, return to Anjadhe &mdash;
                                your account finishes connecting automatically.</li>
                        </ol>
                        <p class="google-connect-privacy">Your email and calendar
                        sync from Google&rsquo;s servers straight to your Mac &mdash;
                        no remote database, no intermediary.</p>
                    </div>
                `,
                buttons: [
                    { text: 'Cancel', className: 'secondary-btn', onClick: () => modal.close() },
                    { text: 'Continue to Google', className: 'primary-btn', onClick: () => { proceed = true; modal.close(); } }
                ],
                onClose: () => resolve(proceed)
            });
        });
    },

    // --- Public mutation API ---

    /**
     * Add a new account or update an existing one (matched by email).
     * Used by the OAuth callback. enabledServices is the set of services
     * the user explicitly granted (or null to default to all known services).
     */
    addOrUpdate({ email, provider = 'google', displayName, enabledServices }) {
        const data = this._load();
        let entry = data.accounts.find(a => a.email === email);
        if (!entry) {
            entry = {
                id: 'acc_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6),
                provider,
                email,
                displayName: displayName || email,
                services: { mail: false, calendar: false },
                connectedAt: new Date().toISOString(),
                lastSyncAt: null
            };
            data.accounts.push(entry);
        }
        if (displayName) entry.displayName = displayName;
        if (enabledServices) {
            for (const svc of enabledServices) {
                entry.services[svc] = true;
            }
        }
        this._save();
        // A fresh OAuth grant just landed tokens on this Mac.
        this._invalidateTokenStatus();
        this.syncToApps();
        this.syncAfterConnect();
        return entry;
    },

    /**
     * Pull email + calendar in the background right after a connect so the
     * user doesn't have to open each app to kick off the first fetch. Both
     * apps already poll headless (deltaSync / syncEvents run off-view), so
     * this is just an immediate first run. syncToApps() has already written
     * the account into the email/calendar stores; reload each app so it
     * picks it up, then sync. Best-effort and quiet — fire and forget.
     */
    async syncAfterConnect() {
        try {
            if (typeof EmailApp !== 'undefined' && typeof EmailApp.loadData === 'function') {
                await EmailApp.loadData();
                if (typeof EmailApp.startSmartSync === 'function') EmailApp.startSmartSync();
                if (typeof EmailApp.setupSyncLifecycle === 'function') EmailApp.setupSyncLifecycle();
                if (typeof EmailApp.deltaSync === 'function') EmailApp.deltaSync();
            }
        } catch (e) { console.warn('[accounts] email sync after connect failed:', e?.message); }
        try {
            if (typeof CalendarApp !== 'undefined' && typeof CalendarApp.loadData === 'function') {
                CalendarApp.loadData();
                if (typeof CalendarApp.syncEvents === 'function') CalendarApp.syncEvents();
            }
        } catch (e) { console.warn('[accounts] calendar sync after connect failed:', e?.message); }
    },

    /**
     * Toggle a service on or off for an account. Does NOT revoke or re-issue
     * tokens — those persist independent of the toggle. Toggling off just
     * hides the service from its app and pauses syncing; toggling on kicks
     * an immediate fetch so the app doesn't sit empty until it is opened.
     */
    setServiceEnabled(email, service, enabled) {
        const data = this._load();
        const entry = data.accounts.find(a => a.email === email);
        if (!entry) return false;
        if (!entry.services) entry.services = {};
        entry.services[service] = !!enabled;
        this._save();
        this.syncToApps();
        if (enabled) this.syncAfterConnect();
        return true;
    },

    /**
     * Fully remove an account: revokes tokens via the main process and
     * removes the entry from the store. Per-app accounts arrays are
     * resynced automatically.
     */
    async remove(email) {
        // Revoke whatever tokens exist for this email. We try both legacy
        // and unified token paths so we clean up everything.
        try {
            if (window.electronEmail?.revokeOAuth) await window.electronEmail.revokeOAuth(email);
        } catch (e) { console.warn('[accounts] gmail revoke failed:', e?.message); }
        try {
            if (window.electronCalendar?.revokeOAuth) await window.electronCalendar.revokeOAuth(email);
        } catch (e) { console.warn('[accounts] calendar revoke failed:', e?.message); }
        try {
            if (window.electronAccounts?.revokeGoogle) await window.electronAccounts.revokeGoogle(email);
        } catch (e) { console.warn('[accounts] google revoke failed:', e?.message); }

        const data = this._load();
        data.accounts = data.accounts.filter(a => a.email !== email);
        this._save();
        this._invalidateTokenStatus();
        this.syncToApps();

        // Wipe per-app data for the removed account (emails, events, tokens,
        // analyses, schedule refs). syncToApps only clears each app's accounts
        // array; without this the actual synced data lingers and reappears on
        // reconnect.
        if (typeof EmailApp !== 'undefined' && typeof EmailApp.cleanupAccountData === 'function') {
            try { await EmailApp.cleanupAccountData(email); }
            catch (e) { console.warn('[accounts] email cleanup failed:', e?.message); }
        }
        if (typeof CalendarApp !== 'undefined' && typeof CalendarApp.cleanupAccountData === 'function') {
            try { await CalendarApp.cleanupAccountData(email); }
            catch (e) { console.warn('[accounts] calendar cleanup failed:', e?.message); }
        }
    }
};
