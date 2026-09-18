/**
 * Feedback Manager — Settings › Send Feedback.
 *
 * Sends what the user wrote to Anjadhe Connect (POST /v1/feedback), under
 * the same privacy stance as analytics, applied to a message the user
 * chose to write: the payload is the message, the kind, an optional
 * reply-to email the user typed, plus exactly what the card DISCLOSES —
 * the app version and platform always, an app-details line (model, OS,
 * setup facts) when its checkbox is on, and the analytics id ONLY when
 * the user ticks a default-off checkbox to let their report be matched
 * with the usage data this Mac already shares. No key rides along and
 * the server keeps no IPs at rest. Pressing Send is the consent; nothing
 * is queued or retried in the background.
 *
 * collectDiagnostics() is BOTH the disclosure and the payload: the card
 * renders what it returns and send() transmits what it returns, so what
 * the user reads can never drift from what a send carries.
 */

const FeedbackManager = {
    ENDPOINT: 'https://api.anjadhe.com/v1/feedback',
    MAX_CHARS: 4000,
    MAX_DETAILS: 700,   // labelled one-per-line facts, so longer than the old ' · ' run

    // Soft local throttle so a stuck double-click can't double-post; the
    // server enforces the real per-hour cap.
    _lastSentAt: 0,

    /**
     * Everything a send can carry besides the message. Each part is
     * best-effort — a source that throws just leaves its fact out.
     * Values are coarse on purpose (counts, on/off, catalog names): a
     * feedback row has no id by default, and a rich distinctive blob of
     * settings would start acting like one.
     */
    async collectDiagnostics() {
        let info = null;
        try { info = await window.electronSystem?.getInfo?.(); } catch { /* below */ }

        // Platform comes from the main process (os.platform/arch), NOT
        // navigator.platform — Chromium freezes that at "MacIntel" even on
        // Apple Silicon, so every Mac read as Intel in the feedback console.
        const osName = info?.platform === 'darwin' ? 'macOS' : (info?.platform || null);
        const platform = info
            ? [osName, info.arch, info.totalMemGB ? `${info.totalMemGB}GB` : null,
               info.rosetta ? 'rosetta' : null].filter(Boolean).join(' ')
            : `${navigator.platform || 'unknown'}`;

        // ONE FACT PER LINE, each saying what it is (2026-09-17). The line
        // used to be a terse ' · ' run ("1 Google account · search off") that
        // read as shorthand to everyone but the person who wrote it. Both
        // readers — the disclosure page in the app and the admin console —
        // render this string as-is, so the wording and the line breaks are
        // part of the payload rather than a formatting pass on top of it.
        const parts = [];
        if (info?.osVersion && osName) parts.push(`Operating system: ${osName} ${info.osVersion}`);

        // The brain — the most useful facts when a report is about the AI,
        // which is most of what feedback about this app is.
        try {
            const def = typeof AgentService !== 'undefined' ? AgentService.getDefaultEntry?.() : null;
            if (def?.model) {
                let model = `Model: ${def.model} (${def.engine || 'unknown engine'}`;
                if (def.engine === 'llamacpp') {
                    try {
                        const eng = await window.electronLlamacpp?.checkEngineUpdate?.();
                        if (eng?.installed) model += ` ${eng.installed}`;
                    } catch { /* engine build is nice-to-have */ }
                    model += `, context ${def.numCtx || 'auto'}`;
                }
                parts.push(model + ')');
            } else {
                parts.push('Model: none configured');
            }
        } catch { /* skip */ }

        // Setup facts — the same signals get_setup_status reads, as counts
        // and on/off only. Never an address, a name, or anything typed.
        try {
            const n = ((typeof AccountsManager !== 'undefined' ? AccountsManager.getAll() : []) || []).length;
            parts.push(`Number of Google accounts configured: ${n}`);
        } catch { /* skip */ }
        // THE id for this Mac — one string that names it to search, the cloud
        // model, quotas and the usage grid alike. Shown as the hash because
        // that is the only form Anjadhe stores; the raw form travels in
        // `analyticsId` below, where the ingest hashes it to exactly this.
        // It rides the app-details box like every other fact here: untick it
        // and no id goes.
        let installId = null, installIdHash = null;
        try {
            const r = await window.electronSearch?.installId?.();
            installId = r?.id || null;
            installIdHash = r?.idHash || null;
            if (installIdHash) parts.push(`This Mac's ID: ${installIdHash}`);
        } catch { /* skip */ }

        // Apple apps (Settings › Accounts › Apple apps) — which of the three
        // one-way imports this Mac has on. Names of lists, folders, notes or
        // events never appear here; only which switch is up.
        try {
            if (typeof AppleImport !== 'undefined') {
                const on = [
                    AppleImport.enabled() ? 'Reminders' : null,
                    AppleImport.notesEnabled() ? 'Notes' : null,
                    AppleImport.eventsEnabled() ? 'Calendar' : null,
                ].filter(Boolean);
                parts.push(`Apple apps: ${on.length ? on.join(', ') : 'none connected'}`);
            }
        } catch { /* skip */ }
        try {
            const s = await window.electronSearch?.getStatus?.();
            parts.push(s?.enabled ? `Web search: on (${s.provider || 'unknown provider'})` : 'Web search: off');
        } catch { /* skip */ }
        try {
            const st = await window.electronSync?.getStatus?.();
            parts.push(`Sync between Macs: ${st?.enabled ? 'on' : 'off'}`);
        } catch { /* skip */ }

        let analyticsOn = false;
        try { analyticsOn = typeof AnalyticsManager !== 'undefined' && AnalyticsManager.isEnabled(); } catch { /* skip */ }
        parts.push(`Anonymous usage signals: ${analyticsOn ? 'on' : 'off'}`);

        try {
            const flags = (typeof FEATURES !== 'undefined' ? FEATURES.experimental() : [])
                .filter((f) => FEATURES.isEnabled(f));
            if (flags.length) parts.push(`Experimental features on: ${flags.join(', ')}`);
        } catch { /* skip */ }

        return {
            appVersion: info?.appVersion || null,
            platform: platform.slice(0, 40),
            details: parts.join('\n').slice(0, this.MAX_DETAILS),
            // The raw id, for the `analyticsId` field the server hashes into
            // feedback.analytics_hash — which is what makes the admin row's
            // "usage" link land on this same install. Same identity as the
            // hash shown on the details line above.
            installId,
            installIdHash,
        };
    },

    async send({ kind, message, email, includeDetails = true } = {}) {
        const text = String(message || '').trim();
        if (text.length < 3) return { success: false, error: 'Write a message first.' };
        if (text.length > this.MAX_CHARS) {
            return { success: false, error: `Message is too long (max ${this.MAX_CHARS} characters).` };
        }
        if (Date.now() - this._lastSentAt < 5000) {
            return { success: false, error: 'Just sent. Give it a moment.' };
        }

        const d = await this.collectDiagnostics();

        try {
            const res = await fetch(this.ENDPOINT, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    kind: kind === 'support' ? 'support' : 'feedback',
                    message: text,
                    email: String(email || '').trim() || undefined,
                    appVersion: d.appVersion || undefined,
                    platform: d.platform,
                    diagnostics: (includeDetails && d.details) || undefined,
                    // This Mac's id, riding the same switch as the details it
                    // is listed among (it used to have a box of its own). The
                    // server keeps only its SHA-256 — the value the card
                    // showed — so the admin row can link to this install.
                    analyticsId: (includeDetails && d.installId) || undefined
                })
            });
            const body = await res.json().catch(() => ({}));
            if (!res.ok) {
                return { success: false, error: body.error || `Send failed (HTTP ${res.status}).` };
            }
            this._lastSentAt = Date.now();
            return { success: true };
        } catch {
            return { success: false, error: 'Could not reach Anjadhe. Check your connection and try again.' };
        }
    }
};
