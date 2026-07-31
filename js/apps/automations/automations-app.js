/**
 * Automations page (docs/COWORK_AGENT.md C8.5) — the deferred "Tasks pane":
 * what's waiting on you, what's armed to run unattended, and what recently
 * ran (with what it changed, from the C8.4 write ledger).
 *
 * Named "Automations", not "Tasks": schedule items are already called tasks
 * everywhere (Actions' front-door tab included), and one word must not mean
 * two things in the launcher.
 *
 * Read-mostly surface: armed automations can be toggled/run/removed here,
 * waiting tasks resumed/cancelled — but automations are CREATED only through
 * the assistant's consent-gated create_automation tool.
 */
const AutomationsApp = {
    _refreshTimer: null,

    // AppManager calls init() then render() on every open. The interval
    // keeps the page live-ish while visible (unattended task status moves on
    // its own out here) and stops itself once the view deactivates.
    init() {
        clearInterval(this._refreshTimer);
        this._refreshTimer = setInterval(() => {
            if (document.getElementById('automations-view')?.classList.contains('active')) this.render();
            else clearInterval(this._refreshTimer);
        }, 4000);
    },

    render() {
        this._renderWaiting();
        this._renderArmed();
        this._renderGrants();
        this._renderRecent();
    },

    /**
     * C8.6: the surface that makes a standing grant safe to give — what the
     * assistant may do unasked, how much of any budget it used today, and a
     * one-tap revoke.
     */
    async _renderGrants() {
        const section = document.getElementById('automations-grants-section');
        const box = document.getElementById('automations-grants');
        if (!section || !box || typeof PermissionManager === 'undefined') return;
        await PermissionManager.ready();
        const grants = PermissionManager.listGrants();
        section.hidden = grants.length === 0;
        if (!grants.length) return;
        const label = (g) => {
            if (g.tool === 'fs:read') return `Read files in ${g.scope}`;
            if (g.tool === 'fs:write') return `Write files in ${g.scope}`;
            if (g.tool === 'shell') return `Run commands starting with "${g.scope}"`;
            if (g.tool.startsWith('mcp:')) return `Every tool from MCP server "${g.tool.slice(4)}"`;
            return g.tool.replace(/_/g, ' ');
        };
        const today = new Date().toISOString().slice(0, 10);
        box.innerHTML = grants.map(g => {
            const bits = [];
            if (g.budget > 0) bits.push(`${g.usedDay === today ? (g.usedCount || 0) : 0}/${g.budget} used today`);
            if (g.expiresAt) bits.push(`until ${new Date(g.expiresAt).toLocaleDateString()}`);
            if ((g.exclusions || []).includes('new_recipient')) bits.push('known contacts only');
            if (!bits.length) bits.push('no limits — add some in Settings');
            return `
            <div class="automations-row" data-grant="${this._esc(g.id)}">
                <div class="automations-row-main">
                    <div class="automations-row-title">${this._esc(label(g))}</div>
                    <div class="automations-row-sub">${this._esc(bits.join(' · '))}</div>
                </div>
                <span class="automations-row-actions">
                    <button class="secondary-btn" data-act="revoke">Revoke</button>
                </span>
            </div>`;
        }).join('');
        box.onclick = async (e) => {
            const btn = e.target.closest('button[data-act="revoke"]');
            if (!btn) return;
            const id = btn.closest('[data-grant]')?.dataset.grant;
            if (!id) return;
            await PermissionManager.revoke(id);
            UIUtils.showToast('Permission revoked — the assistant will ask again', 'success');
            this.render();
        };
    },

    _esc(s) { return UIUtils.escapeHtml(String(s ?? '')); },

    _when(iso) {
        const t = Date.parse(iso);
        if (!t) return '';
        const mins = Math.round((Date.now() - t) / 60000);
        if (mins < 1) return 'just now';
        if (mins < 60) return `${mins}m ago`;
        if (mins < 60 * 24) return `${Math.round(mins / 60)}h ago`;
        return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    },

    _renderWaiting() {
        const section = document.getElementById('automations-waiting-section');
        const box = document.getElementById('automations-waiting');
        if (!section || !box || typeof TaskService === 'undefined') return;
        const waiting = TaskService._all().filter(t => t && ['awaiting_user', 'paused'].includes(t.status));
        section.hidden = waiting.length === 0;
        box.innerHTML = waiting.map(t => `
            <div class="automations-row" data-task="${this._esc(t.id)}">
                <div class="automations-row-main">
                    <div class="automations-row-title">${this._esc(t.goal)}</div>
                    <div class="automations-row-sub">${this._esc(t.note || t.status)}</div>
                </div>
                <span class="automations-row-actions">
                    <button class="secondary-btn" data-act="${t.status === 'paused' ? 'resume' : 'approve'}">${t.status === 'paused' ? 'Resume' : 'Review &amp; run'}</button>
                    <button class="secondary-btn" data-act="cancel">Cancel</button>
                </span>
            </div>`).join('');
        box.onclick = async (e) => {
            const btn = e.target.closest('button[data-act]');
            if (!btn) return;
            const id = btn.closest('[data-task]')?.dataset.task;
            if (!id) return;
            const act = btn.dataset.act;
            // Resuming/approving from here is a human decision — TaskService
            // marks the run attended, so asks show their normal dialog.
            if (act === 'resume') await TaskService.resume(id);
            else if (act === 'approve') await TaskService.approve(id);
            else if (act === 'cancel') TaskService.cancel(id);
            this.render();
        };
    },

    _renderArmed() {
        const box = document.getElementById('automations-armed');
        if (!box || typeof AutomationService === 'undefined') return;
        const list = AutomationService.all();
        if (!list.length) {
            box.innerHTML = '<p class="automations-empty">Nothing armed yet.</p>';
            return;
        }
        box.innerHTML = list.map(a => `
            <div class="automations-row${a.enabled ? '' : ' is-disabled'}" data-auto="${this._esc(a.id)}">
                <div class="automations-row-main">
                    <div class="automations-row-title">${this._esc(a.goal)}</div>
                    <div class="automations-row-sub">
                        ${this._esc(AutomationService.triggerLabel(a))}
                        ${a.lastRunAt ? ` &middot; last ran ${this._esc(this._when(a.lastRunAt))}` : ' &middot; not run yet'}
                        ${a.lastError ? ` &middot; <span class="automations-error">${this._esc(a.lastError)}</span>` : ''}
                    </div>
                </div>
                <span class="automations-row-actions">
                    <button class="secondary-btn" data-act="run">Run now</button>
                    <button class="secondary-btn" data-act="toggle">${a.enabled ? 'Disable' : 'Enable'}</button>
                    <button class="secondary-btn" data-act="remove">Remove</button>
                </span>
            </div>`).join('');
        box.onclick = async (e) => {
            const btn = e.target.closest('button[data-act]');
            if (!btn) return;
            const id = btn.closest('[data-auto]')?.dataset.auto;
            const a = id && AutomationService.get(id);
            if (!a) return;
            const act = btn.dataset.act;
            if (act === 'toggle') AutomationService.setEnabled(id, !a.enabled);
            else if (act === 'remove') {
                const ok = await UIUtils.confirm('Remove this automation?', 'It stops running; past task results are kept below.');
                if (ok) AutomationService.remove(id);
            } else if (act === 'run') {
                btn.disabled = true;
                const r = await AutomationService.runNow(id);
                UIUtils.showToast(r.error || 'Started — it appears under Recent tasks', r.error ? 'error' : 'success');
            }
            this.render();
        };
    },

    _renderRecent() {
        const box = document.getElementById('automations-recent');
        if (!box || typeof TaskService === 'undefined') return;
        const recent = TaskService._all()
            .filter(t => t && !['awaiting_user', 'paused'].includes(t.status))
            .slice(0, 15);
        if (!recent.length) {
            box.innerHTML = '<p class="automations-empty">No tasks have run yet.</p>';
            return;
        }
        box.innerHTML = recent.map(t => {
            const mark = t.status === 'done' ? '✓' : ['planning', 'running', 'verifying'].includes(t.status) ? '…' : '✗';
            // What it actually changed — the C8.4 ledger, not prose.
            let changed = '';
            if (typeof WriteLedger !== 'undefined' && Array.isArray(t.ledgerScopes)) {
                const entries = t.ledgerScopes.map(id => WriteLedger.getScope(id)).filter(Boolean).flatMap(s => s.entries);
                if (entries.length) {
                    const shown = entries.slice(0, 4).map(e => `${e.action} ${this._esc(e.target || e.tool)}`).join(', ');
                    changed = `changed: ${shown}${entries.length > 4 ? ` +${entries.length - 4} more` : ''}`;
                }
            }
            const steps = (t.plan || []).length;
            const doneSteps = (t.plan || []).filter(s => s.status === 'done').length;
            return `
            <div class="automations-row" data-recent="${this._esc(t.id)}">
                <div class="automations-row-main">
                    <div class="automations-row-title"><span class="automations-mark automations-mark--${t.status === 'done' ? 'ok' : 'bad'}">${mark}</span> ${this._esc(t.goal)}</div>
                    <div class="automations-row-sub">
                        ${this._esc(this._when(t.updatedAt))} &middot; ${doneSteps}/${steps} steps
                        ${t.automationId ? ' &middot; automated' : ''}
                        ${changed ? ` &middot; ${changed}` : ''}
                    </div>
                </div>
            </div>`;
        }).join('');
    }
};

if (typeof AppManager !== 'undefined') {
    AppManager.register('automations', AutomationsApp);
}
