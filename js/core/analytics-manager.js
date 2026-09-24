/**
 * Analytics Manager
 *
 * Opt-in, content-free usage analytics. Off by default. When enabled,
 * records anonymous event counts tagged with a per-machine install ID.
 * Message bodies, note text, goal descriptions — none of it goes in
 * here. Only small, pre-declared events from the vocabulary below.
 *
 * Events are recorded locally, visible to the user in Settings →
 * Privacy, and POSTed at most hourly to nenva Connect, which folds
 * them into daily counters on arrival (see anjadhe-connect, public
 * repo). The install ID here is a dedicated random UUID — deliberately
 * NOT the Connect install id — so analytics can't be joined against
 * this machine's search usage server-side.
 */

const AnalyticsManager = {
    STORAGE_KEY: 'analytics',
    MAX_EVENTS: 500,
    MAX_PROP_VALUE_LENGTH: 64,

    ENDPOINT: 'https://api.anjadhe.com/v1/analytics/events',
    UPLOAD_MIN_INTERVAL_MS: 60 * 60 * 1000, // at most once per hour
    UPLOAD_STARTUP_DELAY_MS: 5000,

    // The one-time opt-in nudge should land on someone who has actually
    // lived with the app for a while. Three gates, because no single one
    // of them says that:
    //
    //   * DAYS USED, not page loads. noteLaunch() runs from AppManager.init,
    //     which is a RENDERER init — the reload that ends first-run setup,
    //     Cmd+R, a feature-flag flip, installing a package, a sync merge and
    //     every extra window each counted as a "launch", so a fresh install
    //     could reach three inside a minute and get the modal on day zero.
    //     One count per local day now; everything inside a day is one day.
    //   * WALL CLOCK since the install was first seen here, so three visits
    //     in one morning still are not day three.
    //   * SOMETHING DONE — app opens recorded by AppManager.recordAppUse.
    //     Analytics cannot answer this from its own blob: record() drops
    //     every event until consent, so the blob is empty by construction
    //     before the ask.
    //
    // firstSeenAt is stamped the first time this state is loaded, so an
    // install upgrading into this code waits out the age gate from the
    // upgrade rather than from a timestamp we would have had to invent.
    NUDGE_AFTER_DAYS_USED: 3,
    NUDGE_MIN_AGE_MS: 3 * 24 * 60 * 60 * 1000,
    NUDGE_MIN_APP_OPENS: 8,

    // The complete set of event names we allow. Anything not on this
    // list is rejected — prevents accidental content leakage through
    // a typo'd event name.
    VOCABULARY: Object.freeze({
        'app.opened':           { app: 'string' },
        'email.analyzed':       { result: 'string', model: 'string' },
        'email.action_synced':  {},
        'agent.query.sent':     { model: 'string' },
        // Which brain users add and from which door (source: wizard | default |
        // settings) — the nenva Cloud adoption funnel. Note wizard-source
        // events are structurally sparse: analytics consent usually
        // postdates first-run, and record() drops events pre-consent.
        'model.added':          { engine: 'string', source: 'string' },
        'agent.reply.feedback': { rating: 'string' },
        'goal.status_updated':  {},
        'schedule.task_completed': {},
        'journal.entry_written':   {},
        // A license was claimed or applied on this Mac (class: alpha | paid).
        // A count, never the key or the address — those go to the License
        // endpoint the user invoked, under its own consent.
        'license.claimed':      { class: 'string' },
        'settings.analytics_enabled':  {},
        'settings.analytics_disabled': {},
    }),

    _state: null,

    // The opt-in decision (enabled + "already asked") must outlive the
    // analytics blob, which is sync-excluded and constantly rewritten by
    // event recording/uploads — a stale or racing blob write was wiping
    // the decision, so the nudge kept reappearing. localStorage is
    // machine-local (analytics is per-device by design anyway), durable,
    // and isolated from that churn, so it is the source of truth for the
    // decision bits. The blob still holds installId + pending events.
    LS_ENABLED_KEY: 'analytics.enabled',
    LS_NUDGED_KEY: 'analytics.nudgedAt',

    _lsGet(key) {
        try { return localStorage.getItem(key); } catch { return null; }
    },
    _lsSet(key, value) {
        try { localStorage.setItem(key, String(value)); } catch {}
    },

    _load() {
        if (this._state) return this._state;
        const stored = (typeof StorageManager !== 'undefined' && StorageManager.get(this.STORAGE_KEY)) || {};
        this._state = {
            enabled: stored.enabled === true,
            installId: stored.installId || this._generateInstallId(),
            events: Array.isArray(stored.events) ? stored.events.slice(-this.MAX_EVENTS) : [],
            lastUploadAt: typeof stored.lastUploadAt === 'number' ? stored.lastUploadAt : 0,
            launchCount: typeof stored.launchCount === 'number' ? stored.launchCount : 0,
            lastLaunchDay: typeof stored.lastLaunchDay === 'string' ? stored.lastLaunchDay : '',
            firstSeenAt: typeof stored.firstSeenAt === 'number' ? stored.firstSeenAt : 0,
            nudgedAt: typeof stored.nudgedAt === 'number' ? stored.nudgedAt : 0,
        };
        // Durable decision bits win over whatever the blob says.
        const lsEnabled = this._lsGet(this.LS_ENABLED_KEY);
        if (lsEnabled !== null) this._state.enabled = lsEnabled === 'true';
        const lsNudged = this._lsGet(this.LS_NUDGED_KEY);
        if (lsNudged !== null) {
            const n = Number(lsNudged);
            if (Number.isFinite(n) && n > 0) this._state.nudgedAt = n;
        }
        // Persist back if the installId or the first-seen stamp was just
        // generated. (Both are only ever written once.)
        if (!this._state.firstSeenAt) this._state.firstSeenAt = Date.now();
        if (!stored.installId || !stored.firstSeenAt) this._save();
        return this._state;
    },

    _save() {
        if (typeof StorageManager === 'undefined') return;
        StorageManager.set(this.STORAGE_KEY, this._state);
    },

    _generateInstallId() {
        // RFC 4122 v4 via crypto.randomUUID when available, else a best-effort fallback.
        if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
            return crypto.randomUUID();
        }
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
            const r = (Math.random() * 16) | 0;
            const v = c === 'x' ? r : (r & 0x3) | 0x8;
            return v.toString(16);
        });
    },

    _sanitizeProps(name, props) {
        const schema = this.VOCABULARY[name];
        if (!schema || !props) return {};
        const out = {};
        for (const key of Object.keys(schema)) {
            const value = props[key];
            if (value === undefined || value === null) continue;
            const expected = schema[key];
            if (typeof value !== expected) continue;
            if (typeof value === 'string' && value.length > this.MAX_PROP_VALUE_LENGTH) continue;
            out[key] = value;
        }
        return out;
    },

    isEnabled() {
        return this._load().enabled;
    },

    getInstallId() {
        return this._load().installId;
    },

    /**
     * Adopt THE id for this Mac (2026-09-17). Analytics used to keep a UUID
     * of its own, deliberately separate from the Connect install id so usage
     * could never be joined to service billing. That separation cost the user
     * two ids, two checkboxes and a raw-vs-hash explanation on a card that is
     * only about counters, and it was collapsed by decision: one id now names
     * this Mac to search, the cloud model, quotas and the usage grid alike.
     *
     * Both ingests hash on arrival, so sending the RAW id here is what makes
     * analytics_daily key on the same hash as every Connect table.
     *
     * Called once from AppManager.init, before the startup upload. A Mac that
     * already sent events under the old id starts a new row in the grid —
     * unavoidable when two identities become one, and a one-time cost.
     * Legacy installs mid-migration have no shared id yet; they keep the one
     * they have and adopt on a later launch.
     */
    async adoptSharedId() {
        try {
            const r = await window.electronSearch?.installId?.();
            if (!r?.id) return;
            const state = this._load();
            if (state.installId === r.id) return;
            state.installId = r.id;
            this._save();
        } catch { /* keep the id we have */ }
    },

    setEnabled(enabled) {
        const state = this._load();
        const wasEnabled = state.enabled;
        state.enabled = !!enabled;
        // Durable, churn-proof source of truth for the decision.
        this._lsSet(this.LS_ENABLED_KEY, state.enabled);
        this._save();
        // Record the toggle itself (meta-event) so we know whether the
        // user opted in or out — but only while analytics are on.
        if (!wasEnabled && state.enabled) {
            this.record('settings.analytics_enabled');
        } else if (wasEnabled && !state.enabled) {
            // Write the disabled event before we lose the chance, but
            // only if we still had consent at record time.
            const prevEnabled = state.enabled;
            state.enabled = true;
            this.record('settings.analytics_disabled');
            state.enabled = prevEnabled;
            this._save();
        }
    },

    record(name, props) {
        const state = this._load();
        if (!state.enabled) return;
        if (!this.VOCABULARY[name]) {
            console.warn(`[analytics] ignoring unknown event: ${name}`);
            return;
        }
        const entry = {
            name,
            ts: Date.now(),
            props: this._sanitizeProps(name, props),
        };
        state.events.push(entry);
        if (state.events.length > this.MAX_EVENTS) {
            state.events = state.events.slice(-this.MAX_EVENTS);
        }
        this._save();
    },

    getPendingEvents() {
        return this._load().events.slice();
    },

    getPendingPayload() {
        const state = this._load();
        return {
            installId: state.installId,
            events: state.events.slice(),
            generatedAt: Date.now(),
        };
    },

    clearPendingEvents() {
        const state = this._load();
        state.events = [];
        this._save();
    },

    getVocabulary() {
        return Object.keys(this.VOCABULARY);
    },

    getLastUploadAt() {
        return this._load().lastUploadAt;
    },

    // One count per LOCAL DAY the app was opened, not per renderer init:
    // reloads, extra windows and flag flips inside one day are one day of
    // use. See NUDGE_AFTER_DAYS_USED for why.
    noteLaunch() {
        const state = this._load();
        const today = this._dayKey();
        if (state.lastLaunchDay === today) return;
        state.lastLaunchDay = today;
        state.launchCount = (state.launchCount || 0) + 1;
        this._save();
    },

    _dayKey(at = Date.now()) {
        const d = new Date(at);
        const pad = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    },

    // Total app opens on this Mac — AppManager's own frequency counts, the
    // one machine-local record that the user has done anything. Home is not
    // an app and never reaches recordAppUse, so this counts real detours
    // into the suite.
    _appOpenCount() {
        try {
            if (typeof AppManager === 'undefined' || typeof AppManager.getAppUsage !== 'function') return 0;
            return Object.values(AppManager.getAppUsage() || {})
                .reduce((n, entry) => n + (Number(entry && entry.count) || 0), 0);
        } catch { return 0; }
    },

    shouldNudgeOptIn() {
        const state = this._load();
        if (state.enabled) return false;
        if (state.nudgedAt) return false;
        if (state.launchCount < this.NUDGE_AFTER_DAYS_USED) return false;
        if (!state.firstSeenAt) return false;
        if (Date.now() - state.firstSeenAt < this.NUDGE_MIN_AGE_MS) return false;
        return this._appOpenCount() >= this.NUDGE_MIN_APP_OPENS;
    },

    markNudged() {
        const state = this._load();
        state.nudgedAt = Date.now();
        this._lsSet(this.LS_NUDGED_KEY, state.nudgedAt);
        this._save();
    },

    _uploadInFlight: false,

    async uploadIfDue(options = {}) {
        const force = options.force === true;
        const state = this._load();
        if (!state.enabled) return { skipped: 'disabled' };
        if (!this.ENDPOINT) return { skipped: 'no_endpoint' };
        if (state.events.length === 0) return { skipped: 'empty' };
        if (this._uploadInFlight) return { skipped: 'in_flight' };
        if (!force && state.lastUploadAt && Date.now() - state.lastUploadAt < this.UPLOAD_MIN_INTERVAL_MS) {
            return { skipped: 'too_soon' };
        }

        this._uploadInFlight = true;
        const batch = state.events.slice();
        try {
            const response = await fetch(this.ENDPOINT, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    installId: state.installId,
                    events: batch,
                    generatedAt: Date.now(),
                }),
            });
            if (!response.ok) {
                return { error: `server ${response.status}` };
            }
            // Remove only the events we uploaded; events recorded during
            // the request stay in the buffer for next run.
            const uploadedCount = batch.length;
            state.events = state.events.slice(uploadedCount);
            state.lastUploadAt = Date.now();
            this._save();
            return { uploaded: uploadedCount };
        } catch (err) {
            return { error: (err && err.message) || 'network' };
        } finally {
            this._uploadInFlight = false;
        }
    },

    scheduleStartupUpload() {
        setTimeout(() => {
            this.uploadIfDue().catch(() => {});
        }, this.UPLOAD_STARTUP_DELAY_MS);

        // Keep trying while the app stays open so long-running windows
        // don't accumulate events for days. The per-hour throttle inside
        // uploadIfDue gates actual network calls.
        if (!this._backgroundTimer) {
            this._backgroundTimer = setInterval(() => {
                this.uploadIfDue().catch(() => {});
            }, this.UPLOAD_MIN_INTERVAL_MS);
        }
    },
};

if (typeof window !== 'undefined') {
    window.AnalyticsManager = AnalyticsManager;
}

// The opt-in gate is pinned by tests/analytics-nudge-test.js in plain Node.
if (typeof module !== 'undefined' && module.exports) {
    module.exports = AnalyticsManager;
}
