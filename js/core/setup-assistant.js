/**
 * SetupAssistant — a Stripe-style guided checklist shown after onboarding.
 *
 * Purpose: a fresh install has no data, so the assistant (where we land
 * per the positioning) would otherwise be an empty box. This walks the
 * user through the few steps that make the assistant actually useful:
 *
 *   1. Connect Google    -> Gmail + Calendar flow in (one sign-in), and
 *                           Email Insights then turns important mail into
 *                           tasks automatically (deltaSync queues analysis,
 *                           syncActionItemsToSchedule files the items) —
 *                           one user experience, so ONE step.
 *   2. Ask the assistant -> a guided first prompt. Deliberately a TOUR
 *                           ("what can you do?") rather than a data prompt —
 *                           a fresh install has nothing to plan yet, and the
 *                           get_help corpus makes the tour answer good.
 *
 * Step completion is read from REAL signals where possible, so the
 * checklist reflects truth even if the user did a step elsewhere:
 *   - connect:   AccountsManager has a connected account
 *   - ask:       the user opened the guided assistant prompt (a flag)
 *
 * Persistence is per-device localStorage (Gmail is connected per-Mac and
 * not synced — same rationale as the legacy first-run card).
 */
const SetupAssistant = {
    _KEY: 'anjadhe_setup_assistant',
    _aiReady: null, // cached async check; null = unknown yet

    _state() {
        try {
            return JSON.parse(localStorage.getItem(this._KEY) || '{}') || {};
        } catch {
            return {};
        }
    },

    _save(patch) {
        const next = { ...this._state(), ...patch };
        try { localStorage.setItem(this._KEY, JSON.stringify(next)); } catch {}
        return next;
    },

    // ── Real completion signals ──────────────────────────────────────
    _step1Done() {
        try {
            return typeof AccountsManager !== 'undefined'
                && AccountsManager.getAll().length > 0;
        } catch { return false; }
    },

    _step3Done() {
        return this._state().askedAssistant === true;
    },

    steps() {
        const list = [
            {
                id: 'connect',
                title: 'Connect your Email and Calendar accounts',
                desc: 'One Google sign-in links Gmail and Calendar. Anjadhe then reads your important emails on your Mac and turns things you need to do into tasks — automatically. Optional, and you can disconnect anytime.',
                cta: 'Connect Google',
                done: this._step1Done(),
                action: () => this._connectGoogle()
            },
            {
                id: 'ask',
                title: 'Ask your assistant',
                desc: 'Start with a tour — ask what Anjadhe can do and what to try first. Once email and calendar are in, it can plan your week around them too.',
                cta: 'Try it',
                done: this._step3Done(),
                action: () => this._askAssistant()
            }
        ];
        // No web-search step (removed 2026-08-31 with the wizard's web
        // page): the assistant's FIRST search asks for approval in the
        // standard tool dialog, and approving it is the opt-in — a
        // checklist entry for something automatic was a nag.
        //
        // The alpha license claim (2026-09-01, js/core/license-claim.js):
        // present only while the alpha is open and this Mac holds no key.
        // MATERIALIZES once main's status lands (LicenseClaim.refresh →
        // _rerender), which is also what resurfaces a completed checklist
        // on an existing install — the one new step is the nudge.
        if (typeof LicenseClaim !== 'undefined' && LicenseClaim.stepApplies()) {
            list.push({
                id: 'license',
                title: 'Claim your free alpha license',
                desc: 'Alpha users keep Anjadhe free for good. Claiming puts that on record with a small signed key saved on this Mac; it asks for an email only so the same key can be issued to you again.',
                cta: 'Claim',
                done: false,
                action: () => LicenseClaim.openModal({ source: 'checklist' })
            });
        }
        return list;
    },

    completedCount() {
        return this.steps().filter(s => s.done).length;
    },

    isComplete() {
        // Tied to the live step list, not a hardcoded count: if a future
        // release adds a new setup step, completedCount drops below the
        // total and the assistant (and its Settings entry) resurface.
        return this.completedCount() >= this.steps().length;
    },

    isDismissed() {
        return this._state().dismissed === true;
    },

    shouldShow() {
        return !this.isComplete() && !this.isDismissed();
    },

    dismiss() {
        this._save({ dismissed: true });
        this._removeRendered();
    },

    // Clear the dismissed flag so the checklist surfaces again. Used by
    // the Settings entry point — a user who said "Maybe later" should be
    // able to come back to it.
    reopen() {
        this._save({ dismissed: false });
    },

    // AI is "set up" if a local model was selected or the user connected
    // their own server. Async (llm settings live in the main process); we
    // cache and re-render once known.
    async _refreshAiReady(rerenderTarget) {
        try {
            const a = StorageManager.get('agent-settings');
            if (a && a.selectedModel) { this._aiReady = true; }
            else if (window.electronLLM && window.electronLLM.getSettings) {
                const s = await window.electronLLM.getSettings();
                this._aiReady = !!(s && s.provider === 'custom' && s.customBaseUrl);
            } else {
                this._aiReady = false;
            }
        } catch { this._aiReady = false; }
        // Preserve the Settings host's force flag (same rule as _rerender) —
        // without it this async repaint would blank the page whenever the
        // checklist is complete or dismissed.
        //
        // DEFERRED, never inline: when agent-settings already has a
        // selectedModel this async function hits NO await, so it runs
        // synchronously inside the renderFull that kicked it — and an
        // inline repaint here re-enters that renderFull BETWEEN its sweep
        // and its prepend, mounting two cards (the long-hunted duplicate;
        // field screenshot 2026-07-24, only on Macs with a model
        // configured, which is why blank-slate repros never showed it).
        // A microtask lands after the caller has attached its card, so the
        // repaint's sweep sees it.
        if (rerenderTarget && rerenderTarget.isConnected) {
            queueMicrotask(() => {
                if (!rerenderTarget.isConnected) return;
                this.renderFull(rerenderTarget, { force: rerenderTarget.id === 'setup-assistant-host' });
            });
        }
    },

    // ── Actions ──────────────────────────────────────────────────────
    async _connectGoogle() {
        if (typeof AccountsManager === 'undefined' || !window.electronAccounts) return;
        if (!(await AccountsManager.confirmGoogleConnect())) return;
        if (typeof UIUtils !== 'undefined') UIUtils.showToast('Opening Google sign-in…', 'info');
        try {
            const r = await window.electronAccounts.googleOAuth();
            if (r && r.success && r.email) {
                AccountsManager.addOrUpdate({
                    email: r.email,
                    provider: 'google',
                    displayName: r.displayName,
                    enabledServices: r.services || ['mail', 'calendar']
                });
                if (typeof UIUtils !== 'undefined') UIUtils.showToast(`Connected ${r.email}`, 'success');
                this._rerender();
            } else if (r && r.error && typeof UIUtils !== 'undefined') {
                UIUtils.showToast(`Connection failed: ${r.error}`, 'error');
            }
        } catch (e) {
            if (typeof UIUtils !== 'undefined') UIUtils.showToast(`Connection error: ${e.message}`, 'error');
        }
    },

    _aiGateOrRun(run) {
        if (this._aiReady === false) {
            if (typeof UIUtils !== 'undefined') {
                UIUtils.showToast('Finish setting up your AI in Settings → AI Models first.', 'info');
            }
            if (typeof AppManager !== 'undefined') AppManager.openApp('settings');
            return;
        }
        run();
    },

    // One-click Connect opt-in — the same consent as the setup wizard's
    // "Enable web search" button (the key still mints on first search).
    _askAssistant() {
        this._save({ askedAssistant: true });
        this._aiGateOrRun(() => {
            if (typeof AppManager !== 'undefined') AppManager.openApp('agent');
            setTimeout(() => {
                try {
                    const input = (typeof AgentUI !== 'undefined' && AgentUI.getInput)
                        ? AgentUI.getInput()
                        : document.getElementById('dash-agent-input');
                    if (input) {
                        // A tour prompt, not a data prompt: on a fresh
                        // install there are no tasks or inbox yet, so
                        // "plan my week" answered with an empty shrug.
                        // The assistant's get_help corpus makes this one
                        // genuinely useful from minute one.
                        input.value = 'What can you do? Give me a quick tour of Anjadhe and a few things worth trying first.';
                        input.focus();
                    }
                } catch {}
            }, 200);
        });
    },

    _rerender() {
        // There can be more than one instance live at once (the dashboard
        // compact strip *and* the Settings sub-view full card). querySelector
        // would only catch the first in DOM order — the dashboard strip —
        // leaving the Settings card stale. Re-render every instance.
        const nodes = Array.from(document.querySelectorAll('[data-setup-assistant]'));
        const seen = new Set();
        nodes.forEach(node => {
            if (!node.isConnected) return; // removed by an earlier repaint
            const parent = node.parentElement || node;
            if (seen.has(parent)) return;
            seen.add(parent);
            if (node.dataset.variant === 'compact') {
                this.renderCompact(parent);
            } else {
                // Keep the card alive in the Settings sub-view even if this
                // action completed the last step (shouldShow() would be false).
                this.renderFull(parent, { force: parent.id === 'setup-assistant-host' });
            }
        });
        // A repaint can also MATERIALIZE a step (the web-search step
        // appears once the status answer lands with no provider active),
        // flipping a complete checklist back to incomplete. If the
        // dashboard strip wasn't
        // rendered at the time, there's no node above to repaint — ask the
        // dashboard host to re-evaluate so the strip can (re)surface.
        if (!nodes.some(n => n.dataset.variant === 'compact')
            && typeof AppManager !== 'undefined'
            && typeof AppManager.updateFirstRunCard === 'function') {
            AppManager.updateFirstRunCard();
        }
    },

    _removeRendered() {
        document.querySelectorAll('[data-setup-assistant]').forEach(n => n.remove());
    },

    // ── Rendering ────────────────────────────────────────────────────
    _esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    },

    /** One checklist row (number/check, title, description, CTA). Shared by
     *  the full card and the floating popover. */
    _stepRow(s, i) {
        const row = document.createElement('div');
        row.className = 'setup-assistant-step' + (s.done ? ' done' : '');
        const mark = s.done ? '&#10003;' : (i + 1);
        row.innerHTML =
            `<span class="setup-assistant-mark">${mark}</span>
             <div class="setup-assistant-info">
                 <span class="setup-assistant-step-title">${this._esc(s.title)}</span>
                 <span class="setup-assistant-step-desc">${this._esc(s.desc)}</span>
             </div>`;
        if (!s.done) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'secondary-btn setup-assistant-cta';
            btn.textContent = s.cta;
            btn.addEventListener('click', () => s.action());
            row.appendChild(btn);
        }
        return row;
    },

    /**
     * Full checklist card — used in the assistant empty state.
     * Pass { force: true } (the Settings entry point) to render even when
     * complete or dismissed, so it works as an always-available review.
     */
    renderFull(container, opts) {
        if (!container) return;
        const force = !!(opts && opts.force);
        container.querySelectorAll('[data-setup-assistant]').forEach(n => n.remove());
        // The full card is a singleton: an async repaint racing a
        // navigation once left a stale card stacked next to the fresh one
        // ("two Set up more sections"), so clear ANY full card in the
        // document, not just this container's. Compact strips are per-host
        // and unaffected.
        document.querySelectorAll('[data-setup-assistant][data-variant="full"]').forEach(n => n.remove());
        if (!force && !this.shouldShow()) return;

        if (this._aiReady === null) this._refreshAiReady(container);

        const steps = this.steps();
        const done = steps.filter(s => s.done).length;

        const card = document.createElement('div');
        card.className = 'setup-assistant';
        card.setAttribute('data-setup-assistant', '');
        card.dataset.variant = 'full';

        const header = document.createElement('div');
        header.className = 'setup-assistant-head';
        header.innerHTML =
            `<div class="setup-assistant-title">Set up more</div>
             <div class="setup-assistant-progress">${done} of ${steps.length} done</div>`;
        card.appendChild(header);

        const list = document.createElement('div');
        list.className = 'setup-assistant-list';
        steps.forEach((s, i) => list.appendChild(this._stepRow(s, i)));
        card.appendChild(list);

        if (done >= steps.length) {
            const allset = document.createElement('div');
            allset.className = 'setup-assistant-allset';
            allset.textContent = "You're all set.";
            card.appendChild(allset);
        } else {
            const foot = document.createElement('button');
            foot.type = 'button';
            foot.className = 'setup-assistant-dismiss';
            foot.textContent = 'Maybe later';
            foot.addEventListener('click', () => this.dismiss());
            card.appendChild(foot);
        }

        container.prepend(card);

        // Post-attach self-heal: field evidence (2026-07-24 screenshot)
        // shows two full cards can coexist despite the pre-mount sweep,
        // through a path not yet identified. Whatever raced, keep only
        // the card just mounted — and log the stack so the next
        // occurrence names the code path that created the duplicate.
        const dups = Array.from(document.querySelectorAll('[data-setup-assistant][data-variant="full"]'))
            .filter(n => n !== card);
        if (dups.length) {
            console.error(`[setup-assistant] removed ${dups.length} duplicate full card(s) — please report this stack:`, new Error().stack);
            dups.forEach(n => n.remove());
        }
    },

    /** Compact resumable strip — used on the dashboard. */
    renderCompact(container) {
        if (!container) return;
        container.querySelectorAll('[data-setup-assistant]').forEach(n => n.remove());
        // Same singleton rule as the full card: only one strip exists,
        // wherever a stale one may have been left.
        document.querySelectorAll('[data-setup-assistant][data-variant="compact"]').forEach(n => n.remove());
        if (!this.shouldShow()) return;

        const done = this.completedCount();
        const total = this.steps().length;
        const strip = document.createElement('div');
        strip.className = 'setup-assistant-strip';
        strip.setAttribute('data-setup-assistant', '');
        strip.dataset.variant = 'compact';
        strip.setAttribute('role', 'button');
        strip.tabIndex = 0;
        strip.title = 'Continue in Settings';
        strip.innerHTML =
            `<span class="setup-assistant-strip-text">Set up more of Anjadhe &mdash; ${done} of ${total} done</span>`;

        // The whole pill resumes the checklist on its dedicated page:
        // Settings › Setup Assistant (full card, always renderable).
        const go = () => {
            if (typeof AppManager !== 'undefined') AppManager.openApp('settings');
            setTimeout(() => {
                try { SettingsApp.openSetupAssistant(); } catch { /* view not ready */ }
            }, 50);
        };
        strip.addEventListener('click', (e) => {
            if (e.target.closest('.setup-assistant-strip-x')) return;
            go();
        });
        strip.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); }
        });

        const x = document.createElement('button');
        x.type = 'button';
        x.className = 'setup-assistant-strip-x';
        x.setAttribute('aria-label', 'Dismiss');
        x.title = 'Dismiss';
        x.innerHTML = '&times;';
        x.addEventListener('click', () => this.dismiss());
        strip.appendChild(x);

        container.prepend(strip);
    },

};
// The floating popover variant was removed 2026-07-24: on the Assistant
// view the assistant now greets the user in the chat itself and says
// what Anjadhe can do (agent-ui empty state). The checklist remains on
// the dashboard strip and Settings › Setup Assistant.

if (typeof window !== 'undefined') window.SetupAssistant = SetupAssistant;
