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
    MAX_DETAILS: 500,

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

        const parts = [];
        if (info?.osVersion && osName) parts.push(`${osName} ${info.osVersion}`);

        // The brain — the most useful facts when a report is about the AI,
        // which is most of what feedback about this app is.
        try {
            const def = typeof AgentService !== 'undefined' ? AgentService.getDefaultEntry?.() : null;
            if (def?.model) {
                let model = `model ${def.model} (${def.engine || '?'}`;
                if (def.engine === 'llamacpp') {
                    try {
                        const eng = await window.electronLlamacpp?.checkEngineUpdate?.();
                        if (eng?.installed) model += ` ${eng.installed}`;
                    } catch { /* engine build is nice-to-have */ }
                    model += `, ctx ${def.numCtx || 'auto'}`;
                }
                parts.push(model + ')');
            } else {
                parts.push('no model configured');
            }
        } catch { /* skip */ }

        // Setup facts — the same signals get_setup_status reads, as counts
        // and on/off only. Never an address, a name, or anything typed.
        try {
            const n = ((typeof AccountsManager !== 'undefined' ? AccountsManager.getAll() : []) || []).length;
            parts.push(n ? `${n} Google account${n === 1 ? '' : 's'}` : 'no Google accounts');
        } catch { /* skip */ }
        try {
            const s = await window.electronSearch?.getStatus?.();
            parts.push(s?.enabled ? `search on (${s.provider || '?'})` : 'search off');
        } catch { /* skip */ }
        try {
            const st = await window.electronSync?.getStatus?.();
            parts.push(st?.enabled ? 'sync on' : 'sync off');
        } catch { /* skip */ }

        let analyticsOn = false;
        try { analyticsOn = typeof AnalyticsManager !== 'undefined' && AnalyticsManager.isEnabled(); } catch { /* skip */ }
        parts.push(analyticsOn ? 'analytics on' : 'analytics off');

        try {
            const flags = (typeof FEATURES !== 'undefined' ? FEATURES.experimental() : [])
                .filter((f) => FEATURES.isEnabled(f));
            if (flags.length) parts.push(`flags: ${flags.join(', ')}`);
        } catch { /* skip */ }

        let analyticsId = null;
        try { analyticsId = analyticsOn ? AnalyticsManager.getInstallId() : null; } catch { /* skip */ }

        return {
            appVersion: info?.appVersion || null,
            platform: platform.slice(0, 40),
            details: parts.join(' · ').slice(0, this.MAX_DETAILS),
            analyticsId,
        };
    },

    async send({ kind, message, email, includeDetails = true, includeAnalyticsId = false } = {}) {
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
                    // The raw id, only when the user ticked the box; the
                    // server stores its SHA-256, the same form the
                    // analytics tables use, so the operator can match the
                    // report to that install's usage — and nothing else.
                    analyticsId: (includeAnalyticsId && d.analyticsId) || undefined
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
