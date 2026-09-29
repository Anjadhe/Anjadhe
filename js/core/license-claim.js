/**
 * LicenseClaim — the alpha-license claim as a DOOR, not a Settings page.
 *
 * The claim (docs/BUSINESS_MODEL.md "License") used to live only in
 * Settings › License, which nobody visits. This module makes it reachable
 * where people already are:
 *
 *   - the post-setup checklist (SetupAssistant) carries a "Claim your free
 *     alpha license" step — a fresh install sees it on Home right after the
 *     wizard, and an existing install's completed checklist RESURFACES with
 *     the one new step (the checklist's own rule for a step added later);
 *   - a one-time modal nudge for installs that dismissed the checklist
 *     (the analytics-nudge mould: asked once, recorded durably up front,
 *     never on the same launch as the analytics ask, never during the
 *     wizard, never on a first launch);
 *   - the modal itself, shared by both and by About › Closed Alpha.
 *
 * Deliberately NOT a first-run wizard step: an email field on first launch
 * reads as account creation, which is the one thing the product promises
 * it does not have. The claim asks for an address AFTER the app has shown
 * what it is, and says exactly why.
 *
 * Status comes from main (LicenseStore via window.electronLicense) and is
 * cached here because SetupAssistant.steps() is synchronous; refresh()
 * re-reads and repaints the checklist. Nothing here touches the key.
 */
const LicenseClaim = {
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
        try {
            if (typeof SetupAssistant !== 'undefined') SetupAssistant._rerender();
            if (typeof AppManager !== 'undefined' && AppManager.updateFirstRunCard) AppManager.updateFirstRunCard();
        } catch { /* not mounted yet */ }
        return this._status;
    },

    known() { return this._status !== null; },
    isLicensed() { return !!(this._status && this._status.licensed); },
    /** The claim is offered only while the alpha is open — the server's word when reachable, local policy otherwise. */
    alphaOpen() {
        if (!this._status) return false;
        // A Connect with licensing disabled answers alphaOpen:false meaning
        // "cannot issue right now", not "closed" — only an ENABLED server
        // outranks local policy (alpha.57 shipped "Trial ended" over this).
        return (this._remote && this._remote.enabled) ? this._remote.alphaOpen === true : this._status.alphaOpen === true;
    },
    /** Should the checklist carry the claim step right now? */
    stepApplies() {
        return this.known() && this.alphaOpen() && !this.isLicensed();
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
        // Not while the checklist is on Home showing the step — one ask at a time.
        try { if (typeof SetupAssistant !== 'undefined' && SetupAssistant.shouldShow()) return false; } catch {}
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
        content.innerHTML = `
            <p style="margin: 0 0 var(--space-md); line-height: 1.6;">
                Everyone who installs during the alpha keeps Anjadhe free for good.
                Claiming puts that on record: a small signed key is saved on this Mac,
                and it keeps this Mac on every future release once the alpha closes.
            </p>
            <p style="margin: 0 0 var(--space-sm); font-size: var(--text-sm); color: var(--color-text-secondary); line-height: 1.6;">
                Enter an email address to issue it to. That address is the only thing sent,
                and it is how you get the same key back on another Mac or after a reinstall.
                No account is created.
            </p>
            <input id="license-claim-modal-email" class="feedback-email" type="email" autocomplete="off"
                   placeholder="you@example.com" style="max-width: none;">
            <p id="license-claim-modal-status" class="feedback-status" style="min-height: 1.2em; margin: 0 0 var(--space-xs);"></p>
            <p style="margin: 0; font-size: var(--text-xs); color: var(--color-text-tertiary); line-height: 1.5;">
                Sent: this address and the app version. Details and the key itself live in Settings &rsaquo; License.
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
            setStatus('Claiming…');
            const r = await window.electronLicense.claimAlpha(email);
            busy = false;
            if (r?.error) { setStatus(r.error, true); return; }
            if (typeof AnalyticsManager !== 'undefined') AnalyticsManager.record('license.claimed', { class: 'alpha' });
            modal.close();
            UIUtils.showToast(r.created ? 'Alpha license claimed. Anjadhe is yours, free for good.' : 'Welcome back — your alpha license is restored.', 'success');
            await this.refresh();
            try { if (typeof SettingsApp !== 'undefined') SettingsApp._updateRootHints(); } catch {}
        };

        const modal = Modal.create({
            title: 'Your free alpha license',
            className: 'license-claim-modal',
            content,
            buttons: [
                { text: 'Later', className: 'secondary-btn', onClick: () => modal.close() },
                { text: 'Claim license', className: 'primary-btn', onClick: claim }
            ]
        });
        const input = content.querySelector('#license-claim-modal-email');
        input?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); claim(); } });
        setTimeout(() => input?.focus(), 50);
        console.log('[license] claim modal opened from', source);
    }
};

if (typeof window !== 'undefined') window.LicenseClaim = LicenseClaim;
