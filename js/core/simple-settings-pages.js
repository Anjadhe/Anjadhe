/**
 * SimpleSettings › Backup, App lock, Usage statistics, Data activity, About (2026-10-06, the
 * simplification, docs/SIMPLE_EXPERIENCE.md "Settings as ONE page").
 *
 * Until today these four rows opened the old full SettingsApp (the Storage
 * & Backup view, the Privacy & Security panel, the LLM Logs table, and the
 * version / feedback / license panels), each wearing that app's breadcrumb
 * and sibling cards. Now each is a page of the simple Settings in the
 * Model / Memory / Connectors shape, so nothing
 * on this page opens the full app.
 *
 * Nothing here is a second copy of the machinery:
 *  - Backup writes through window.electronBackup (main owns the settings)
 *    and the passphrase through SettingsApp._syncEncPrompt, the one flow.
 *  - Lock is AppManager's own auth state over window.electronAuth (Touch
 *    ID at open). It is the ONE lock since 2026-10-07 (Locked apps retired).
 *  - Data activity is LLMLogger's ledger (`left === true`),
 *    SearchLogger's record and, since 2026-10-07, AIActivity's `blocked`
 *    rows (ambient work CloudPrivacy kept here because its kind of data may
 *    not leave), read as date · service · kind. Code's facts, no prompt
 *    text: the full log with prompts is the developer's view (Settings ›
 *    Advanced › Developer). Data activity lives alongside those logs;
 *    the AI Activity page is gone.
 *  - About hosts UpdaterUI.renderSettings(host) and
 *    SettingsApp._renderLicense(host), each given a host element instead of
 *    a fixed id, and the feedback form posts through FeedbackManager.send,
 *    with the disclosure read from the same collector send() uses.
 */
Object.assign(SimpleSettings, {

    // ── Plan (2026-10-07, docs/BILLING.md) ─────────────────────────────
    // The person's nenva cloud plan and this month's use, read-only: AI as
    // a percentage with background work shown under it, searches as a
    // count, when it resets. PlanUsage.view builds the facts; nothing here
    // shows a price or a purchase (no prices until checkout exists).

    _planRowValue() {
        const u = typeof PlanUsage !== 'undefined' && PlanUsage._last ? PlanUsage._last.usage : null;
        if (!u) return '';
        const v = PlanUsage.view(u);
        return v.state === 'ok' ? `${v.plan} · ${v.ai.percent}% used` : '';
    },
    _planLocal() {
        const def = typeof AgentService !== 'undefined' && AgentService.getDefaultEntry ? AgentService.getDefaultEntry() : null;
        // nenva local is the llama.cpp engine; a person's own server, OpenAI,
        // Anthropic and nenva cloud are not "on this Mac".
        return !!(def && def.engine === 'llamacpp');
    },
    _meter(percent, level) {
        const p = Math.max(0, Math.min(100, Number(percent) || 0));
        return `<span class="ss-meter${level === 'out' ? ' is-out' : level === 'high' ? ' is-high' : ''}" role="img" aria-label="${p}% used"><span style="width:${p}%"></span></span>`;
    },
    _planHtml(usage) {
        const back = `<button type="button" class="ss-back" data-ss="back">‹ Settings</button><h1 class="ss-title">Plan</h1>`;
        if (!usage) return `${back}<p class="ss-lede">Reading this month's use…</p>`;
        const v = PlanUsage.view(usage, { local: this._planLocal(), country: this._planCountry });
        if (v.state === 'error') return `${back}<p class="ss-lede">Can't reach nenva Connect right now, so this month's use can't be shown. Try again in a moment.</p>`;
        if (v.state === 'unused') return `${back}<p class="ss-lede">This Mac hasn't used nenva cloud or nenva's web search yet, so there is nothing to count.${v.local ? ' Your model, nenva local, runs on this Mac with no monthly limit.' : ''}</p>`;
        const n = (x) => Number(x).toLocaleString('en-US');
        const bl = v.billing;
        const lede = bl.paid && bl.renews ? `${this._esc(v.plan)} plan · renews ${this._esc(bl.renews)} · usage resets ${this._esc(v.resets)}`
            : bl.trialEnds ? `${this._esc(v.plan)} trial · ends ${this._esc(bl.trialEnds)}`
            : `${this._esc(v.plan)} plan${v.resets ? ` · resets ${this._esc(v.resets)}` : ''}`;
        return `${back}
            <p class="ss-lede">${lede}</p>
            ${bl.paid && bl.status === 'past_due' ? `<p class="ss-note ss-warn">Your last payment didn't go through. Update your card in Manage subscription; your plan keeps working for a few days meanwhile.</p>` : ''}
            ${bl.lapsed ? `<p class="ss-note">Your paid plan has ended, so this Mac is on the Free plan.</p>` : ''}
            <div class="ss-group">
                <div class="ss-row ss-field-row ss-plan-row">
                    <span class="ss-pick-copy"><span class="ss-label">nenva cloud</span>
                        <span class="ss-sub">${v.ai.percent}% of this month's allowance used${v.ai.backgroundPercent ? ` · ${v.ai.backgroundPercent}% of it by background work (reading your email, routines)` : ''}${bl.topup.cloud ? ' · extra cloud use from a top-up' : ''}</span></span>
                    ${this._meter(v.ai.percent, v.aiLevel)}
                </div>
                <div class="ss-row ss-field-row ss-plan-row">
                    <span class="ss-pick-copy"><span class="ss-label">Web searches</span>
                        <span class="ss-sub">${n(v.searches.used)} of ${n(v.searches.allowance)} this month${bl.topup.searches ? ` · ${n(bl.topup.searches)} extra from a top-up` : ''}</span></span>
                    ${this._meter(v.searches.allowance ? v.searches.used / v.searches.allowance * 100 : 0, v.searchLevel)}
                </div>
            </div>
            ${v.aiLevel === 'out' ? `<p class="ss-note">This month's nenva cloud allowance is used. <button type="button" class="ss-link" data-ss="page" data-id="model">Choose nenva local</button> to keep going on this Mac.</p>` : ''}
            ${this._planTopupHtml(v)}
            ${v.local ? `<p class="ss-note">Your model, nenva local, runs on this Mac with no monthly limit. The allowance above counts only nenva cloud.</p>` : ''}
            ${this._planBuyHtml(v)}
            <div class="ss-group">
                <button type="button" class="ss-row" data-ss="plan-search-key">
                    <span class="ss-label">Use your own search key</span><span class="ss-value">Searches with it are not counted</span>${this._chev}
                </button>
            </div>`;
    },

    // ── Buying and managing (billing P3) ──
    // Choose a plan → Stripe's checkout in the person's own browser, the
    // price shown there before they pay; this page waits for the payment.
    // A paid plan: Manage (Stripe's portal), the code for another Mac,
    // Remove from this Mac. Plan words name what a plan gives, in the
    // server's numbers; no price is written here.
    _planInterval: 'month',
    _planWaiting: false,
    _planCodeOpen: false,
    _planShowCode: null,
    _planCountry: '', // the Mac's region, from main; '' until read (counts as yes)
    _planBuyHtml(v) {
        const bl = v.billing;
        const n = (x) => Number(x).toLocaleString('en-US');
        if (this._planWaiting) {
            return `<div class="ss-group"><div class="ss-row ss-field-row">
                    <span class="ss-pick-copy"><span class="ss-label">Finish paying in your browser</span>
                        <span class="ss-sub">This page updates on its own when the payment is done.</span></span>
                    <button type="button" class="ss-btn" data-ss="plan-stop-waiting">Stop waiting</button>
                </div></div>`;
        }
        if (bl.paid) {
            const code = this._planShowCode;
            return `<div class="ss-group">
                    ${bl.manage ? `<button type="button" class="ss-row" data-ss="plan-manage"><span class="ss-label">Manage subscription</span><span class="ss-value">Change plan, card or cancel</span>${this._chev}</button>` : ''}
                    <button type="button" class="ss-row" data-ss="plan-show-code"><span class="ss-label">Use on another Mac</span><span class="ss-value">${code ? '' : 'Show your plan code'}</span>${this._chev}</button>
                    ${code ? `<div class="ss-row ss-field-row"><code class="ss-code">${this._esc(code)}</code><button type="button" class="ss-btn" data-ss="plan-copy-code">Copy</button></div>
                        <p class="ss-sub ss-code-note">On the other Mac, open Settings › Plan › I have a code. One code works on a few of your Macs.</p>` : ''}
                    <button type="button" class="ss-row" data-ss="plan-detach"><span class="ss-label ss-danger">Remove plan from this Mac</span><span class="ss-value">The subscription continues</span>${this._chev}</button>
                </div>`;
        }
        const choose = bl.available ? (() => {
            const iv = bl.plans.some(p => p.intervals.includes(this._planInterval)) ? this._planInterval : (bl.plans[0].intervals[0] || 'month');
            const twoIntervals = bl.plans.some(p => p.intervals.includes('month')) && bl.plans.some(p => p.intervals.includes('year'));
            const what = (p) => p.id === 'pro' ? `nenva cloud pro and lite · ${n(p.searches)} web searches a month`
                : `nenva cloud for everyday use · ${n(p.searches)} web searches a month`;
            return `<h2 class="ss-eyebrow">Plans</h2>
                ${twoIntervals ? `<div class="ss-seg" role="group" aria-label="Billing">
                    <button type="button" class="ss-seg-btn" data-ss="plan-interval" data-id="month" aria-pressed="${iv === 'month'}">Monthly</button>
                    <button type="button" class="ss-seg-btn" data-ss="plan-interval" data-id="year" aria-pressed="${iv === 'year'}">Yearly</button>
                </div>` : ''}
                <div class="ss-group">${bl.plans.map(p => `
                    <div class="ss-row ss-field-row">
                        <span class="ss-pick-copy"><span class="ss-label">${this._esc(p.name)}</span><span class="ss-sub">${this._esc(what(p))}</span></span>
                        ${p.intervals.includes(iv) ? `<button type="button" class="ss-btn ss-btn-primary" data-ss="plan-choose" data-id="${this._esc(p.id)}">Choose ${this._esc(p.name)}</button>` : '<span class="ss-sub">Not offered yearly</span>'}
                    </div>`).join('')}
                </div>
                <p class="ss-note">You pay on Stripe's secure page in your browser, which shows the price before you pay. Cancel any time from Manage subscription.</p>`;
        })() : '';
        const elsewhere = bl.elsewhere
            ? `<p class="ss-note">Paid plans are available in the United States for now. Everything else in nenva works here, including nenva cloud's monthly allowance.</p>`
            : '';
        return `${choose}${elsewhere}
            <div class="ss-group">
                <button type="button" class="ss-row" data-ss="plan-code"><span class="ss-label">I have a code</span><span class="ss-value">From another Mac or your receipt</span>${this._chev}</button>
                ${this._planCodeOpen ? `<div class="ss-row ss-field-row">
                    <input type="text" class="ss-input" data-plan-code-input placeholder="nenva-XXXXX-XXXXX-…" autocomplete="off" spellcheck="false" aria-label="Plan code">
                    <button type="button" class="ss-btn ss-btn-primary" data-ss="plan-apply-code">Apply</button>
                </div>` : ''}
            </div>`;
    },
    /** Top-ups (P5): offered when running low or out; sizes from the server, the price on Stripe's page. */
    _planTopupHtml(v) {
        const bl = v.billing;
        if (!bl.packs.length || this._planWaiting) return '';
        const want = bl.packs.filter(p => (p.searches && v.searchLevel !== 'ok') || (p.cloud && v.aiLevel !== 'ok'));
        if (!want.length) return '';
        const n = (x) => Number(x).toLocaleString('en-US');
        return `<div class="ss-group">${want.map(p => `
                <div class="ss-row ss-field-row">
                    <span class="ss-pick-copy"><span class="ss-label">${p.searches ? `${n(p.searches)} more web searches` : 'More nenva cloud'}</span>
                        <span class="ss-sub">A one-time top-up, used after this month's allowance. It doesn't expire.</span></span>
                    <button type="button" class="ss-btn" data-ss="plan-topup" data-id="${this._esc(p.id)}">Add</button>
                </div>`).join('')}</div>`;
    },
    async _planAct(ss, id, el) {
        const B = window.electronBilling;
        if (!B) return;
        const wrap = el.closest('.ss-wrap');
        const refresh = () => { if (typeof PlanUsage !== 'undefined') PlanUsage._last = null; if (this._page === 'plan') this.render(); };
        if (ss === 'plan-interval') { this._planInterval = id === 'year' ? 'year' : 'month'; this.render(); return; }
        if (ss === 'plan-choose') {
            el.disabled = true;
            const r = await B.checkout(id, this._planInterval);
            if (r && r.error) { el.disabled = false; UIUtils.showToast(r.error, 'error'); return; }
            this._planWaiting = true; this.render(); return;
        }
        if (ss === 'plan-topup') {
            el.disabled = true;
            const r = await B.topup(id);
            if (r && r.error) { el.disabled = false; UIUtils.showToast(r.error, 'error'); return; }
            this._planWaiting = true; this.render(); return;
        }
        if (ss === 'plan-stop-waiting') { await B.stopWaiting(); this._planWaiting = false; this.render(); return; }
        if (ss === 'plan-code') { this._planCodeOpen = !this._planCodeOpen; this.render(); setTimeout(() => wrap?.querySelector('[data-plan-code-input]')?.focus(), 0); return; }
        if (ss === 'plan-apply-code') {
            const input = wrap?.querySelector('[data-plan-code-input]');
            const code = input ? input.value.trim() : '';
            if (!code) return;
            el.disabled = true;
            const r = await B.attach(code);
            el.disabled = false;
            if (r && r.error) { UIUtils.showToast(r.error, 'error'); return; }
            this._planCodeOpen = false;
            UIUtils.showToast(r.active ? `This Mac is on the ${PlanUsage.planName(r.plan)} plan` : 'Code added. Its subscription is not active right now.', r.active ? 'success' : 'info');
            refresh(); return;
        }
        if (ss === 'plan-manage') { const r = await B.portal(); if (r && r.error) UIUtils.showToast(r.error, 'error'); return; }
        if (ss === 'plan-show-code') {
            if (this._planShowCode) { this._planShowCode = null; this.render(); return; }
            const r = await B.code();
            this._planShowCode = r && r.code ? r.code : null;
            if (!this._planShowCode) UIUtils.showToast('This Mac does not have the code saved. It is on your receipt page.', 'info');
            this.render(); return;
        }
        if (ss === 'plan-copy-code' && this._planShowCode) {
            try { await navigator.clipboard.writeText(this._planShowCode); UIUtils.showToast('Code copied', 'success'); } catch { /* clipboard denied */ }
            return;
        }
        if (ss === 'plan-detach') {
            const ok = typeof UIUtils.confirm === 'function'
                ? await UIUtils.confirm('Remove plan from this Mac', 'This Mac goes back to the Free plan. The subscription itself continues; cancel it in Manage subscription. You can add the plan back with its code.', '', { confirmText: 'Remove' })
                : true;
            if (!ok) return;
            const r = await B.detach();
            if (r && r.error) { UIUtils.showToast(r.error, 'error'); return; }
            this._planShowCode = null; refresh();
        }
    },
    /** Main says a checkout ended (paid, or stopped waiting): repaint. */
    _wirePlanEvents() {
        if (this._planWired || !window.electronBilling) return;
        this._planWired = true;
        window.electronBilling.onChanged((info) => {
            this._planWaiting = !!info.waiting;
            if (typeof PlanUsage !== 'undefined') PlanUsage._last = null;
            if (info.paid && info.topup) UIUtils.showToast('Top-up added', 'success');
            else if (info.paid) UIUtils.showToast(info.plan ? `You're on the ${PlanUsage.planName(info.plan)} plan` : 'Your plan is active', 'success');
            if (this._page === 'plan' && typeof AppManager !== 'undefined' && AppManager.currentApp === 'simplesettings') this.render();
        });
        window.electronBilling.code().then(r => { if (r && r.waiting) this._planWaiting = true; }).catch(() => {});
    },
    async _fillPlan(wrap) {
        this._wirePlanEvents();
        const [usage, region] = await Promise.all([
            typeof PlanUsage !== 'undefined' ? PlanUsage.fetch() : { error: 'unavailable' },
            window.electronBilling && window.electronBilling.region ? window.electronBilling.region().catch(() => null) : null
        ]);
        if (region && typeof region.country === 'string') this._planCountry = region.country;
        if (this._page !== 'plan') return;
        wrap.innerHTML = this._planHtml(usage);
    },

    // ── Taught tasks (2026-10-07, docs/TEACH.md) ───────────────────────
    // What the person showed nenva how to do on a website, beside what it
    // remembers about them. The note is the playbook the Browser agent
    // follows; it reads as plain text here and the person can rewrite it.

    _taughtOn() { return typeof TaughtTasks !== 'undefined' && TaughtTasks.enabled(); },
    _taughtRowHtml() {
        if (!this._taughtOn()) return '';
        let n = 0; try { n = TaughtTasks.all().length; } catch { /* optional */ }
        return `<button type="button" class="ss-row" data-ss="taught">
                    ${this._tile('<rect x="3" y="5" width="18" height="13" rx="2"/><path d="M3 9h18M8 21h8"/>')}
                    <span class="ss-label">Taught tasks</span><span class="ss-value">${n ? `${n}` : 'None yet'}</span>${this._chev}
                </button>`;
    },
    _taughtHtml() {
        if (!this._taughtOn()) return '';
        const items = TaughtTasks.all();
        const when = iso => { try { return this._when(iso); } catch { return ''; } };
        const groups = items.map(item => `
            <div class="ss-group ss-form ss-taught" data-taught-id="${this._esc(item.id)}">
                <div class="ss-row ss-field-row">
                    <span class="ss-pick-copy"><span class="ss-label">${this._esc(item.title)}</span>
                        <span class="ss-sub">${this._esc(item.hosts.join(', '))} · taught ${this._esc(when(item.taughtAt))}${item.lastRun ? ` · last run ${this._esc(when(item.lastRun.at))}` : ''}</span></span>
                    <button type="button" class="ss-btn ss-btn-primary" data-ss="taught-run" data-id="${this._esc(item.id)}">Run</button>
                </div>
                <textarea class="ss-textarea" data-taught-note="${this._esc(item.id)}" rows="6" aria-label="What nenva learned for ${this._esc(item.title)}">${this._esc(item.note)}</textarea>
                <div class="ss-row ss-field-row ss-taught-actions">
                    <span class="ss-sub ss-taught-status" data-taught-status="${this._esc(item.id)}">Edit the note above; it is saved when you leave the box.</span>
                    <button type="button" class="ss-btn" data-ss="taught-routine" data-id="${this._esc(item.id)}">Repeat on a schedule</button>
                    <button type="button" class="ss-btn" data-ss="taught-remove" data-id="${this._esc(item.id)}">Forget</button>
                </div>
            </div>`).join('');
        return `<button type="button" class="ss-back" data-ss="back" data-id="memory">‹ Memory</button>
            <h1 class="ss-title">Taught tasks</h1>
            <p class="ss-lede">Website tasks you showed nenva once, in its own Chrome window. Each note is what it learned, in words; nenva follows it with judgment when you ask for the task by name, or on a schedule, and hands over to you at a sign-in.</p>
            ${groups || `<p class="ss-note">Nothing taught yet. In a chat, say <em>“let me show you how I…”</em> and nenva opens its Chrome window and watches. Passwords, codes and card numbers are never recorded.</p>`}
            <div class="ss-group">
                <div class="ss-row ss-field-row">
                    <span class="ss-pick-copy"><span class="ss-label">nenva's browser</span><span class="ss-sub" data-taught-browser>Checking…</span></span>
                    <button type="button" class="ss-btn" data-ss="taught-browser" hidden>Set up</button>
                </div>
            </div>`;
    },
    /** Whether nenva's own Chrome window is connected (main's fact), and the door to set it up. */
    async _fillTaughtBrowser(wrap) {
        if (!this._taughtOn()) return;
        const line = wrap.querySelector('[data-taught-browser]'), button = wrap.querySelector('[data-ss="taught-browser"]');
        if (!line || !window.electronAgentBrowser) return;
        let state = null;
        try { state = await window.electronAgentBrowser.command('chrome-state'); } catch { state = null; }
        if (!line.isConnected) return;
        const text = !state ? 'Not available' : !state.supported ? 'Needs macOS or Linux' : !state.available ? 'Google Chrome is not installed'
            : state.connected ? `Connected${state.stale ? ' · its extension updates when idle' : ''}` : 'Not set up: nenva installs its extension in a Chrome window of its own';
        line.textContent = text;
        if (button) button.hidden = !state || !state.available || !!state.connected;
    },
    _taughtAct(ss, id, button) {
        if (!this._taughtOn()) return;
        const item = TaughtTasks.get(id);
        if (!item && ss !== 'taught-browser') return;
        if (ss === 'taught-browser' && typeof AgentUI !== 'undefined') { AgentUI.askWithPrompt('Set up the browser.', { newChat: true }); return; }
        if (ss === 'taught-run' && typeof AgentUI !== 'undefined') {
            AgentUI.askWithPrompt(`Run the taught task “${item.title}” and tell me what you found.`, { newChat: true });
        } else if (ss === 'taught-routine' && typeof AgentUI !== 'undefined') {
            AgentUI.askWithPrompt(`Set up a routine that runs my taught task “${item.title}” and tells me what it found. Ask me how often, then create it.`, { newChat: true });
        } else if (ss === 'taught-remove') {
            const go = typeof UIUtils !== 'undefined' && UIUtils.confirm ? UIUtils.confirm('Forget this task?', `nenva forgets how to do “${this._esc(item.title)}”. You can show it again any time.`, '', { confirmText: 'Forget' }) : Promise.resolve(true);
            go.then(yes => { if (!yes) return; TaughtTasks.remove(id); this.render(); if (typeof UIUtils !== 'undefined') UIUtils.showToast(`Forgot “${item.title}”`, 'info'); });
        }
    },
    /** The note's textarea saves on blur (wired once per render through the page's blur listener). */
    _taughtNoteBlur(target) {
        const id = target?.dataset?.taughtNote;
        if (!id || !this._taughtOn()) return;
        const item = TaughtTasks.get(id);
        if (!item || item.note === target.value.trim()) return;
        const status = document.querySelector(`[data-taught-status="${CSS.escape(id)}"]`);
        const result = TaughtTasks.updateNote(id, target.value);
        if (status) { status.textContent = result.error ? result.error : 'Saved.'; status.classList.toggle('ss-warn', !!result.error); }
    },

    // ── Backup ─────────────────────────────────────────────────────────

    async _backupHtml() {
        let st = { enabled: false, frequency: 'daily', lastBackup: null, backupPath: null };
        if (window.electronBackup && window.electronBackup.getSettings) {
            try { st = Object.assign(st, await window.electronBackup.getSettings()); } catch { /* main owns it */ }
        }
        this._backupState = st;
        let enc = null;
        if (window.electronSync && window.electronSync.encryptionStatus) {
            try { enc = await window.electronSync.encryptionStatus(); } catch { enc = null; }
        }
        const last = st.lastBackup ? this._when(st.lastBackup) : 'Never';
        const freq = { hourly: 'Every hour', daily: 'Every day', weekly: 'Every week' };
        const freqOpts = Object.entries(freq).map(([v, l]) => `<option value="${v}"${st.frequency === v ? ' selected' : ''}>${l}</option>`).join('');
        const detail = !st.enabled ? '' : `
                <button type="button" class="ss-row" data-ss="backup-folder">
                    <span class="ss-pick-copy"><span class="ss-label">Folder</span><span class="ss-sub">${this._esc(st.backupPath || 'Choose a folder')}</span></span><span class="ss-value">Change</span>${this._chev}
                </button>
                <label class="ss-row ss-field-row">
                    <span class="ss-label">How often</span>
                    <select class="ss-select" data-ss-select="backup-frequency" aria-label="How often to back up">${freqOpts}</select>
                </label>
                <div class="ss-row ss-field-row">
                    <span class="ss-pick-copy"><span class="ss-label">Last backup</span><span class="ss-sub">${this._esc(last)}</span></span>
                    <button type="button" class="ss-btn" data-ss="backup-now">Back up now</button>
                </div>`;
        return `<button type="button" class="ss-back" data-ss="back">‹ Settings</button>
            <h1 class="ss-title">Backup</h1>
            <p class="ss-lede">A copy of everything nenva keeps, written to a folder you choose. A backup can be opened on this Mac, or on another with your passphrase.</p>
            <div class="ss-group">
                <label class="ss-row ss-switch-row">
                    <span class="ss-pick-copy"><span class="ss-label">Back up nenva</span><span class="ss-sub">${st.enabled ? 'On' : 'Off'}</span></span>
                    <span class="settings-switch"><input type="checkbox" data-ss-switch="backup"${st.enabled ? ' checked' : ''} aria-label="Back up nenva"><span class="settings-switch-track"></span></span>
                </label>${detail}
            </div>
            ${this._passphraseHtml(enc)}
            <div class="ss-group">
                <button type="button" class="ss-row" data-ss="backup-restore">
                    <span class="ss-pick-copy"><span class="ss-label">Restore from a backup</span><span class="ss-sub">Pick a backup file; nenva replaces what it holds with it.</span></span>${this._chev}
                </button>
            </div>`;
    },

    /** The passphrase as ONE row: a sentence on where things stand and the one action that fits it (SettingsApp._renderSyncEncryption's states). */
    _passphraseHtml(enc) {
        if (!enc || !enc.state) return '';
        const copy = {
            passphrase: 'Set. Your backups open on any Mac with it.',
            mismatch: 'This Mac is on a different key, so your passphrase would not open its newest backups. Enter it to fix that.',
            locked: 'Locked. Enter your passphrase to resume backups on this Mac.',
            plaintext: 'Not set. Your backup key is unprotected in iCloud; a passphrase secures it.',
            'local-only': 'Not set. Backups open only on this Mac; a passphrase lets them open on another.',
            none: 'No backup key on this Mac.'
        }[enc.state] || '';
        const act = enc.locked ? ['unlock', 'Enter']
            : enc.state === 'mismatch' ? ['recover', 'Enter']
            : enc.upgradeable ? ['set', 'Set']
            : enc.state === 'passphrase' ? ['change', 'Change']
            : null;
        return `<div class="ss-group">
                <div class="ss-row ss-field-row">
                    <span class="ss-pick-copy"><span class="ss-label">Passphrase</span><span class="ss-sub${enc.state === 'locked' || enc.state === 'mismatch' ? ' ss-warn' : ''}">${this._esc(copy)}</span></span>
                    ${act ? `<button type="button" class="ss-btn" data-ss="passphrase" data-id="${act[0]}">${act[1]}</button>` : ''}
                </div>
            </div>`;
    },

    async _backupAct(kind, id, el) {
        if (!window.electronBackup) return;
        if (kind === 'backup') {
            el.disabled = true;
            try {
                await window.electronBackup.setEnabled(!!id);
                if (id) {
                    const r = await window.electronBackup.backupNow();
                    if (r && r.success) UIUtils.showToast('Backup on', 'success');
                    else if (r && r.error) UIUtils.showToast('Backup failed: ' + r.error, 'error');
                }
            } catch (err) { UIUtils.showToast(err && err.message ? err.message : 'Could not change that', 'error'); }
            finally { el.disabled = false; }
            this.render(); return;
        }
        if (kind === 'backup-folder') {
            const folder = window.electronDialog && window.electronDialog.selectFolder ? await window.electronDialog.selectFolder() : null;
            if (!folder) return;
            await window.electronBackup.setBackupPath(folder);
            UIUtils.showToast('Backup folder updated', 'success');
            this.render(); return;
        }
        if (kind === 'backup-frequency') { await window.electronBackup.setFrequency(id); return; }
        if (kind === 'backup-now') {
            el.disabled = true; el.textContent = 'Backing up…';
            try {
                const r = await window.electronBackup.backupNow();
                if (r && r.success) UIUtils.showToast('Backup completed', 'success');
                else UIUtils.showToast('Backup failed: ' + ((r && r.error) || 'unknown'), 'error');
            } catch (err) { UIUtils.showToast('Backup failed: ' + err.message, 'error'); }
            this.render(); return;
        }
        if (kind === 'backup-restore') { if (AppManager.showRestoreBackupPicker) await AppManager.showRestoreBackupPicker(); return; }
        if (kind === 'passphrase' && typeof SettingsApp !== 'undefined' && SettingsApp._syncEncPrompt) {
            await SettingsApp._syncEncPrompt(id);
            this.render();
        }
    },

    // ── Lock ───────────────────────────────────────────────────────────

    _lockHtml() {
        const avail = !!AppManager.authAvailable;
        const on = !!AppManager.authEnabled;
        const mins = [1, 2, 5, 10, 15, 30];
        const cur = Number(AppManager.autoLockTimeout) || 5;
        const opts = mins.map(m => `<option value="${m}"${cur === m ? ' selected' : ''}>${m} min</option>`).join('');
        return `<button type="button" class="ss-back" data-ss="back" data-id="privacy">‹ Privacy &amp; security</button>
            <h1 class="ss-title">App lock</h1>
            <p class="ss-lede">${avail
                ? 'Touch ID, or your Mac login password, before nenva opens and after it has sat idle.'
                : 'Locking nenva uses Touch ID, which this Mac does not have.'}</p>
            ${avail ? `<div class="ss-group">
                <label class="ss-row ss-switch-row">
                    <span class="ss-pick-copy"><span class="ss-label">Lock nenva</span><span class="ss-sub">${on ? 'On' : 'Off'}</span></span>
                    <span class="settings-switch"><input type="checkbox" data-ss-switch="lock"${on ? ' checked' : ''} aria-label="Lock nenva"><span class="settings-switch-track"></span></span>
                </label>
                ${on ? `<label class="ss-row ss-field-row">
                    <span class="ss-label">Lock after</span>
                    <select class="ss-select" data-ss-select="lock-after" aria-label="Lock after">${opts}</select>
                </label>` : ''}
            </div>` : ''}`;
    },

    async _lockAct(kind, id, el) {
        if (!window.electronAuth) return;
        if (kind === 'lock') {
            const on = !!id;
            el.disabled = true;
            try {
                if (on) {
                    const r = await window.electronAuth.promptTouchID();
                    if (!r || !r.success) { el.checked = false; return; }
                }
                AppManager.authEnabled = on;
                await window.electronAuth.setAuthEnabled(on);
                if (on) { AppManager.lastActivityTime = Date.now(); AppManager.startActivityTracking?.(); }
                else AppManager.stopActivityTracking?.();
            } finally { el.disabled = false; }
            this.render(); return;
        }
        if (kind === 'lock-after') {
            const minutes = parseInt(id, 10) || 5;
            AppManager.autoLockTimeout = minutes;
            await window.electronAuth.setAutoLockTimeout(minutes);
            AppManager.lastActivityTime = Date.now();
        }
    },

    // ── Usage statistics ───────────────────────────────────────────────

    _analyticsHtml() {
        const on = typeof AnalyticsManager !== 'undefined' && AnalyticsManager.isEnabled ? !!AnalyticsManager.isEnabled() : false;
        return `<button type="button" class="ss-back" data-ss="back" data-id="privacy">‹ Privacy &amp; security</button>
            <h1 class="ss-title">Share usage statistics</h1>
            <p class="ss-lede">Help improve nenva by sharing which features you use. Usage events are sent to nenva with a random ID for this Mac, without your mail, notes or chat content. Sharing is off by default and you can turn it off at any time.</p>
            <div class="ss-group">
                <label class="ss-row ss-switch-row">
                    <span class="ss-label">Share usage statistics</span>
                    <span class="settings-switch"><input type="checkbox" data-ss-switch="analytics"${on ? ' checked' : ''} aria-label="Share usage statistics"><span class="settings-switch-track"></span></span>
                </label>
            </div>`;
    },

    // ── Data activity ──────────────────────────────────────────────────

    /** Pure: the ledger as rows of {ts, service, kind}, newest first, from LLM calls that left, web searches and work kept on this Mac (`kept`: AIActivity items with status 'blocked'). Pinned by tests/simple-settings-left-test.js. */
    leftRows(llmLogs, searchLogs, { limit = 200, kindOf, kept } = {}) {
        const rows = [];
        for (const k of Array.isArray(kept) ? kept : []) {
            if (!k || k.status !== 'blocked') continue;
            const ts = k.endedAt || k.startedAt;
            rows.push({ ts: typeof ts === 'number' ? new Date(ts).toISOString() : String(ts || ''), service: 'Kept on this Mac', kind: String(k.label || 'Kept on this Mac').replace(/ kept on this Mac$/i, '') });
        }
        for (const l of Array.isArray(llmLogs) ? llmLogs : []) {
            if (!l || l.left !== true) continue;
            rows.push({ ts: l.timestamp, service: l.destination || 'Left this Mac', kind: (kindOf ? kindOf(l.source) : null) || 'AI' });
        }
        for (const s of Array.isArray(searchLogs) ? searchLogs : []) {
            if (!s) continue;
            const service = s.provider === 'anjadhe' ? 'nenva agent web search' : s.provider ? `${s.provider} search` : 'Web search';
            rows.push({ ts: s.timestamp, service, kind: 'Web search' });
        }
        rows.sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')));
        return rows.slice(0, limit);
    },

    /** What kind of data a call carried: the surface the source tag belongs to (model-routing.js), in the person's words. */
    _kindOfSource(source) {
        if (source === 'slack-monitor') return 'Slack'; // main's own call, not a routed surface
        try {
            const id = ModelRouting.surfaceOf(source);
            const s = ModelRouting.SURFACES.find(x => x.id === id);
            if (!s) return null;
            return { assistant: 'Chat', email: 'Mail and texts', documents: 'Documents', portfolio: 'Finance', routines: 'Routines and commitments', quick: 'Small jobs' }[s.id] || s.label;
        } catch { return null; }
    },

    _leftHtml() {
        const llm = typeof LLMLogger !== 'undefined' ? LLMLogger.logs : [];
        const search = typeof SearchLogger !== 'undefined' ? SearchLogger.logs : [];
        const kept = typeof AIActivity !== 'undefined' ? AIActivity.recent : [];
        const rows = this.leftRows(llm, search, { kindOf: (s) => this._kindOfSource(s), kept });
        const head = `<button type="button" class="ss-back" data-ss="developer">‹ Developer</button>
            <h1 class="ss-title">Data activity</h1>
            <p class="ss-lede">Recent AI requests and web searches sent to online services, showing when, where and the type of activity. “Kept on this Mac” means a privacy setting prevented that work from being sent. This history stays on this Mac and shows no message or search content.</p>`;
        if (!rows.length) return head + '<div class="ss-group"><p class="ss-empty">No recent activity.</p></div>';
        let day = '', html = '';
        for (const r of rows) {
            const d = this._day(r.ts);
            if (d !== day) { if (day) html += '</div>'; html += `<div class="ss-eyebrow">${this._esc(d)}</div><div class="ss-group ss-ledger">`; day = d; }
            html += `<div class="ss-row ss-ledger-row"><span class="ss-ledger-time">${this._esc(this._time(r.ts))}</span><span class="ss-label">${this._esc(r.service)}</span><span class="ss-value">${this._esc(r.kind)}</span></div>`;
        }
        return head + html + '</div>';
    },

    _day(ts) {
        const d = new Date(ts); if (isNaN(d)) return '';
        const today = new Date(); const y = new Date(); y.setDate(today.getDate() - 1);
        const same = (a, b) => a.toDateString() === b.toDateString();
        if (same(d, today)) return 'Today';
        if (same(d, y)) return 'Yesterday';
        return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
    },
    _time(ts) { const d = new Date(ts); return isNaN(d) ? '' : d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); },
    _when(ts) { const d = new Date(ts); return isNaN(d) ? '' : `${this._day(ts)} ${this._time(ts)}`; },

    // ── About ──────────────────────────────────────────────────────────

    _aboutHtml() {
        return `<button type="button" class="ss-back" data-ss="back">‹ Settings</button>
            <h1 class="ss-title">About</h1>
            <div class="ss-group ss-host" data-ss-host="version"><p class="ss-empty">Reading the version…</p></div>
            <div class="ss-group">
                <button type="button" class="ss-row" data-ss="page" data-id="feedback">
                    <span class="ss-pick-copy"><span class="ss-label">Send feedback</span><span class="ss-sub">To the person who makes nenva.</span></span>${this._chev}
                </button>
                <button type="button" class="ss-row" data-ss="page" data-id="registration">
                    <span class="ss-pick-copy"><span class="ss-label">Registration</span><span class="ss-sub">Product updates and new features.</span></span>${this._chev}
                </button>
                <button type="button" class="ss-row" data-ss="about-nenva">
                    <span class="ss-label">About nenva</span>${this._chev}
                </button>
            </div>`;
    },
    _fillAbout(wrap) {
        const host = wrap.querySelector('[data-ss-host="version"]');
        if (host && typeof UpdaterUI !== 'undefined' && UpdaterUI.renderSettings) UpdaterUI.renderSettings(host);
    },

    _feedbackHtml() {
        return `<button type="button" class="ss-back" data-ss="back" data-id="about">‹ About</button>
            <h1 class="ss-title">Send feedback</h1>
            <p class="ss-lede">What should be better? What broke? What do you wish nenva did? It goes straight to the person who wrote the app.</p>
            <div class="ss-group ss-form">
                <label class="ss-row ss-field-row">
                    <span class="ss-label">This is</span>
                    <select class="ss-select" data-ss-fb="kind"><option value="feedback">feedback or an idea</option><option value="support">a support request</option></select>
                </label>
                <textarea class="ss-textarea" data-ss-fb="message" rows="6" maxlength="4000" placeholder="Your message"></textarea>
                <input class="ss-input" data-ss-fb="email" type="email" autocomplete="off" placeholder="Your email (optional, only if you want a reply)">
                <label class="ss-row ss-switch-row">
                    <span class="ss-pick-copy"><span class="ss-label">Send app details</span><span class="ss-sub ss-fb-details"></span></span>
                    <span class="settings-switch"><input type="checkbox" data-ss-fb="details" checked aria-label="Send app details"><span class="settings-switch-track"></span></span>
                </label>
                <div class="ss-row ss-field-row">
                    <span class="ss-sub ss-fb-status" aria-live="polite"></span>
                    <button type="button" class="ss-btn ss-btn-primary" data-ss="feedback-send">Send</button>
                </div>
            </div>
            <p class="ss-foot">Nothing you have written in nenva goes with this: no mail, documents, commitments or chats. Only your message and, if ticked, the details above, over an encrypted connection. <button type="button" class="ss-link" data-ss="founder">Contact the founder</button> instead, if you would rather reach a person.</p>`;
    },
    /** The disclosure IS the payload: the details line is read from the collector send() uses, so what is shown cannot drift from what is sent. */
    async _fillFeedback(wrap) {
        const line = wrap.querySelector('.ss-fb-details');
        if (!line || typeof FeedbackManager === 'undefined') return;
        try { const d = await FeedbackManager.collectDiagnostics(); line.textContent = (d && d.details) || ''; } catch { line.textContent = ''; }
    },
    async _sendFeedback(wrap, btn) {
        if (typeof FeedbackManager === 'undefined') return;
        const q = (k) => wrap.querySelector(`[data-ss-fb="${k}"]`);
        const status = wrap.querySelector('.ss-fb-status');
        btn.disabled = true;
        if (status) { status.textContent = 'Sending…'; status.classList.remove('ss-warn'); }
        const r = await FeedbackManager.send({
            kind: q('kind') && q('kind').value,
            message: q('message') && q('message').value,
            email: q('email') && q('email').value,
            includeDetails: !q('details') || q('details').checked !== false
        });
        btn.disabled = false;
        if (r && r.success) { if (q('message')) q('message').value = ''; if (status) status.textContent = 'Sent. Thank you!'; }
        else if (status) { status.textContent = (r && r.error) || 'Could not send'; status.classList.add('ss-warn'); }
    },

    _registrationHtml() {
        return `<button type="button" class="ss-back" data-ss="back" data-id="about">‹ About</button>
            <h1 class="ss-title">Registration</h1>
            <div class="ss-group ss-host ss-license" data-ss-host="license"><p class="ss-empty">Reading…</p></div>`;
    },
    _fillRegistration(wrap) {
        const host = wrap.querySelector('[data-ss-host="license"]');
        if (host && typeof SettingsApp !== 'undefined' && SettingsApp._renderLicense) SettingsApp._renderLicense(host);
    }
});
