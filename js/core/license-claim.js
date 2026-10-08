/**
 * LicenseClaim — the free-license claim as a DOOR, not a Settings page.
 *
 * nenva is free for good (2026-09-30, docs/BUSINESS_MODEL.md); the license
 * is how a person REGISTERS, and the email they give is how nenva reaches
 * them: release news and important notices, with an unsubscribe link in
 * every email. The modal says exactly that, which is why claiming sends
 * `contact: true` (main's license-claim) — the words on this screen ARE
 * the consent, so they must not drift from what Connect does with the
 * address. Open to everyone, always (it was alpha-only until 2026-09-30).
 *
 * The claim used to live only in Settings › License, which nobody visits.
 * This module makes it reachable where people already are:
 *
 *   - a one-time modal nudge (the analytics-nudge mould: asked once,
 *     recorded durably up front, never on the same launch as the analytics
 *     ask, never during the wizard, never on a first launch);
 *   - the modal itself, shared by the nudge and by About.
 *   (The post-setup checklist that also carried a claim step was removed
 *   2026-10-01 with the Setup Assistant.)
 *
 * First run requires email registration (2026-10-07). It uses the same
 * claim and disclosure; setup waits for the signed license to be saved.
 *
 * Status comes from main (LicenseStore via window.electronLicense) and is
 * cached here; refresh() re-reads it. Nothing here touches the key.
 */
const LicenseClaim = {
    // Shared by first run, the claim modal and Settings. Main sends
    // contact:true only when the user presses the disclosed claim action.
    REGISTRATION_COPY: 'For product updates and new features. Unsubscribe anytime.',
    REGISTRATION_SHORT_COPY: 'For product updates and new features. Unsubscribe anytime.',

    plansHtml() {
        return `<dl class="license-plans">
            <div><dt>nenva cloud lite <span>Subscription planned</span></dt><dd>Cloud AI for everyday questions and tasks. Planned billing covers inference usage and a share of cloud hosting, with no markup.</dd></div>
            <div><dt>nenva cloud pro <span>Subscription planned</span></dt><dd>A more capable cloud model for harder work. The same at-cost pricing, based on this model’s usage and hosting costs.</dd></div>
        </dl><p class="license-plans-note">Cloud currently includes a free monthly allowance. Paid cloud service will be priced at cost. Rates and billing are not available yet. Choosing a model does not subscribe you or charge you.</p>`;
    },

    /** One claim path for every door. Failed IPC is a retryable UI error. */
    async claim(email) {
        try {
            const result = await window.electronLicense.claim(email);
            if (result?.error) return result;
            if (!result?.licensed) return { error: 'Your license could not be saved. Please try again.' };
            this._status = result;
            this.markNudged();
            // Optional telemetry must not turn a saved license into a failure.
            try {
                if (typeof AnalyticsManager !== 'undefined') AnalyticsManager.record('license.claimed', { class: result.class || null });
            } catch { /* registration already succeeded */ }
            return result;
        } catch {
            return { error: 'Could not get your license. Check your connection and try again.' };
        }
    },

    LS_NUDGED_KEY: 'license.nudgedAt',
    // Not before the second launch: the first is the wizard's, and the
    // checklist step is already on Home.
    NUDGE_MIN_LAUNCHES: 2,
    NUDGE_DELAY_MS: 20000,

    _status: null,   // last LicenseStore.status() seen; null = unknown yet
    _remote: undefined, // /v1/license/status answer; undefined = not asked, null = unreachable

    async init() {
        if (!window.electronLicense) return;
        await this.refresh();
        if (this.shouldNudge()) {
            setTimeout(() => this.showNudge(), this.NUDGE_DELAY_MS);
        }
    },

    /** Re-read status from main and repaint the checklist that shows the step. */
    async refresh() {
        try {
            this._status = await window.electronLicense.get();
        } catch { this._status = null; }
        if (this._remote === undefined) {
            // Asked once per session: the server is what would honour a claim.
            this._remote = null;
            try { this._remote = await window.electronLicense.remoteStatus(); } catch { /* offline */ }
        }
        return this._status;
    },

    known() { return this._status !== null; },
    isLicensed() { return !!(this._status && this._status.licensed); },
    /**
     * Can a license be claimed? Yes, unless the server that would issue it
     * says otherwise (licensing switched off on that deploy). Offline the
     * claim is still offered; claiming then says Connect cannot be reached.
     */
    claimOpen() {
        if (!this._remote) return true;
        return this._remote.enabled === true && this._remote.claimOpen !== false;
    },
    /** Should the checklist carry the claim step right now? */
    stepApplies() {
        return this.known() && this.claimOpen() && !this.isLicensed();
    },

    // ── the one-time nudge ──────────────────────────────────────────────
    _nudgedAt() {
        try { return Number(localStorage.getItem(this.LS_NUDGED_KEY)) || 0; } catch { return 0; }
    },
    markNudged() {
        try { localStorage.setItem(this.LS_NUDGED_KEY, String(Date.now())); } catch {}
    },
    shouldNudge() {
        if (!this.stepApplies() || this._nudgedAt()) return false;
        if (document.body.classList.contains('in-setup')) return false;
        // Never the same launch as the analytics ask, and never the first launch.
        try {
            if (typeof AnalyticsManager !== 'undefined') {
                if (AnalyticsManager.shouldNudgeOptIn()) return false;
                const launches = AnalyticsManager._load?.().launchCount || 0;
                if (launches < this.NUDGE_MIN_LAUNCHES) return false;
            }
        } catch {}
        return true;
    },
    showNudge() {
        if (!this.shouldNudge()) return;
        this.markNudged(); // asked = asked, however the modal ends
        this.openModal({ source: 'nudge' });
    },

    // ── the modal ───────────────────────────────────────────────────────
    /**
     * Email → claim → toast. Shared by the checklist step, the nudge and
     * About. Stays open on an error so the address is not lost.
     */
    openModal({ source = 'unknown' } = {}) {
        if (typeof Modal === 'undefined' || !window.electronLicense) return;
        if (this.isLicensed()) {
            UIUtils.showToast('This Mac already has a license. See Settings › License.', 'success');
            return;
        }
        const content = document.createElement('div');
        // These words are the consent Connect acts on (see the header).
        content.innerHTML = `
            <p style="margin: 0 0 var(--space-md); line-height: 1.6;">
                ${this.REGISTRATION_COPY}
            </p>
            <p style="margin: 0 0 var(--space-sm); font-size: var(--text-sm); color: var(--color-text-secondary); line-height: 1.6;">
                It also gets you the same license back on another Mac or after a reinstall.
                Cloud AI is priced separately.
            </p>
            <input id="license-claim-modal-email" class="feedback-email" type="email" autocomplete="off"
                   placeholder="you@example.com" style="max-width: none;">
            <p id="license-claim-modal-status" class="feedback-status" style="min-height: 1.2em; margin: 0 0 var(--space-xs);"></p>
            <p style="margin: 0; font-size: var(--text-xs); color: var(--color-text-tertiary); line-height: 1.5;">
                Sent: this address and the app version. Your license lives in Settings &rsaquo; License.
            </p>`;

        let busy = false;
        const setStatus = (text, isErr) => {
            const el = content.querySelector('#license-claim-modal-status');
            if (!el) return;
            el.textContent = text || '';
            el.classList.toggle('is-error', !!isErr);
        };
        const claim = async () => {
            if (busy) return;
            const email = content.querySelector('#license-claim-modal-email')?.value || '';
            if (!email.trim()) { setStatus('Enter an email address first.', true); return; }
            busy = true;
            setStatus('Getting your license…');
            const r = await this.claim(email);
            busy = false;
            if (r?.error) { setStatus(r.error, true); return; }
            modal.close();
            UIUtils.showToast(r.created ? 'Your free nenva license is on this Mac.' : 'Welcome back. Your license is restored on this Mac.', 'success');
            await this.refresh();
            try { if (typeof SettingsApp !== 'undefined') SettingsApp._updateRootHints(); } catch {}
        };

        const modal = Modal.create({
            title: 'Get your free nenva license',
            className: 'license-claim-modal',
            content,
            buttons: [
                { text: 'Later', className: 'secondary-btn', onClick: () => modal.close() },
                { text: 'Get license', className: 'primary-btn', onClick: claim }
            ]
        });
        const input = content.querySelector('#license-claim-modal-email');
        input?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); claim(); } });
        setTimeout(() => input?.focus(), 50);
        console.log('[license] claim modal opened from', source);
    }
};

if (typeof window !== 'undefined') window.LicenseClaim = LicenseClaim;
