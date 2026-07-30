/**
 * Portfolio Strategy UI
 *
 * Renders the strategy: the compact adherence card on the main portfolio
 * view, the full Strategy page, and the per-account strip.
 *
 * There is deliberately no editor here. A strategy is written and changed by
 * TALKING to the assistant — every button on this page opens that
 * conversation with the right context already loaded. What the app owns is
 * the structural stuff a chat is a bad fit for: which strategy is the overall
 * one, which account follows which, and deleting.
 */

const PortfolioStrategyUI = {

    /** Prompt that opens the guided intake. */
    INTERVIEW_PROMPT: 'Help me build an investment strategy for my portfolio. ' +
        'I am not sure what a strategy needs to cover, so please walk me through it one question at a time.',

    // ── Main-view card ───────────────────────────────────────────────────

    /**
     * The at-a-glance card above the holdings table: is the money still being
     * invested the way it was agreed? Hidden entirely when there is no
     * strategy AND nothing invested — a brand-new portfolio should not be
     * nagged before it has a single holding.
     */
    renderCard(containerId) {
        const el = document.getElementById(containerId);
        if (!el || typeof PortfolioStrategy === 'undefined') return;
        const hasAssistant = typeof AgentUI !== 'undefined';

        const strategy = PortfolioStrategy.getDefault();
        const holdings = PortfolioApp.computeHoldings() || [];

        if (!strategy) {
            if (!holdings.length || !hasAssistant) { this._hide(el); return; }
            el.style.display = '';
            el.innerHTML = `
                <div class="portfolio-strategy-card is-empty">
                    <div class="portfolio-strategy-card-body">
                        <span class="portfolio-strategy-card-title">No strategy yet</span>
                        <p class="portfolio-strategy-card-sub">You are holding ${holdings.length} position${holdings.length === 1 ? '' : 's'} without a written plan behind them. Talk it through with Anjadhe and it will ask you what a strategy needs to cover.</p>
                    </div>
                    <button type="button" class="primary-btn" data-strategy-action="interview">Build one with Anjadhe</button>
                </div>
            `;
            this._wire(el);
            return;
        }

        if (strategy.status === 'draft') {
            const missing = PortfolioStrategy.missingTopics(strategy);
            el.style.display = '';
            el.innerHTML = `
                <div class="portfolio-strategy-card is-draft">
                    <div class="portfolio-strategy-card-body">
                        <span class="portfolio-strategy-card-title">${AppManager.escapeHtml(strategy.name)} <span class="portfolio-strategy-pill is-draft">Unfinished</span></span>
                        <p class="portfolio-strategy-card-sub">${missing.length} question${missing.length === 1 ? '' : 's'} still to work through before this can be tracked.</p>
                    </div>
                    <button type="button" class="secondary-btn" data-strategy-action="resume">Pick up where we left off</button>
                    <button type="button" class="portfolio-strategy-card-open" data-strategy-action="open" title="Open the Strategy page">&rarr;</button>
                </div>
            `;
            this._wire(el);
            return;
        }

        const report = PortfolioStrategy.evaluate(strategy);
        if (!report || report.empty) { this._hide(el); return; }

        el.style.display = '';
        el.innerHTML = `
            <div class="portfolio-strategy-card is-${report.status}">
                <div class="portfolio-strategy-card-body">
                    <span class="portfolio-strategy-card-title">
                        ${AppManager.escapeHtml(strategy.name)}
                        ${this._statusPill(report.status)}
                    </span>
                    <p class="portfolio-strategy-card-sub">${AppManager.escapeHtml(report.headline)}</p>
                    ${this._miniBars(report)}
                </div>
                <div class="portfolio-strategy-card-actions">
                    ${hasAssistant ? `<button type="button" class="secondary-btn" data-strategy-action="review">Review with Anjadhe</button>` : ''}
                    <button type="button" class="portfolio-strategy-card-open" data-strategy-action="open" title="Open the Strategy page">&rarr;</button>
                </div>
            </div>
        `;
        this._wire(el, strategy, report);
    },

    /** Compact target bars — percentages only, so Hide Values stays honest. */
    _miniBars(report) {
        const targets = (report.targets || []).slice(0, 5);
        if (!targets.length) return '';
        return `
            <div class="portfolio-strategy-bars">
                ${targets.map(t => `
                    <div class="portfolio-strategy-bar-row" title="${AppManager.escapeHtml(t.label)}: ${t.actualPct.toFixed(1)}% against a ${t.targetPct}% target (band ${t.minPct}-${t.maxPct}%)">
                        <span class="portfolio-strategy-bar-label">${AppManager.escapeHtml(t.label)}</span>
                        <span class="portfolio-strategy-bar-track">
                            <span class="portfolio-strategy-bar-fill is-${t.status}" style="width: ${Math.min(100, Math.max(0, t.actualPct)).toFixed(1)}%"></span>
                            <span class="portfolio-strategy-bar-marker" style="left: ${Math.min(100, Math.max(0, t.targetPct)).toFixed(1)}%"></span>
                        </span>
                        <span class="portfolio-strategy-bar-pct is-${t.status}">${t.actualPct.toFixed(0)}%</span>
                    </div>
                `).join('')}
            </div>
        `;
    },

    _statusPill(status) {
        const map = {
            'on-track': ['is-ok', 'On track'],
            drift: ['is-drift', 'Drifting'],
            breach: ['is-breach', 'Off plan'],
            'no-data': ['is-draft', 'No data']
        };
        const [cls, label] = map[status] || map['no-data'];
        return `<span class="portfolio-strategy-pill ${cls}">${label}</span>`;
    },

    _hide(el) { el.innerHTML = ''; el.style.display = 'none'; },

    // ── Full Strategy page ───────────────────────────────────────────────

    renderView(selectedId = null) {
        const el = document.getElementById('portfolio-strategy-content');
        if (!el) return;
        const strategies = PortfolioStrategy.all();

        if (!strategies.length) {
            el.innerHTML = `
                <div class="empty-state portfolio-strategy-empty">
                    <span class="empty-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r="1"/></svg></span>
                    <h3>No strategy yet</h3>
                    <p>A strategy is what you check a trade against before you make it. Most people do not know what one needs to contain, so Anjadhe asks you: what the money is for, when you need it, how much of a drop you could sit through, and what limits you want to hold yourself to. It turns your answers into a plan it can track.</p>
                    <button type="button" class="primary-btn" data-strategy-action="interview" style="margin-top: var(--space-md);">Build one with Anjadhe</button>
                </div>
            `;
            this._wire(el);
            return;
        }

        const active = strategies.find(s => s.id === selectedId)
            || PortfolioStrategy.getDefault()
            || strategies[0];

        el.innerHTML = `
            ${strategies.length > 1 ? `
                <div class="portfolio-tabs portfolio-strategy-tabs">
                    ${strategies.map(s => `
                        <button type="button" class="portfolio-tab ${s.id === active.id ? 'active' : ''}" data-strategy-tab="${s.id}">
                            ${AppManager.escapeHtml(s.name)}${s.isDefault ? ' <span class="portfolio-strategy-tab-flag">overall</span>' : ''}
                        </button>
                    `).join('')}
                </div>
            ` : ''}
            ${this._detailHtml(active)}
        `;
        this._wire(el, active, null);
    },

    _detailHtml(strategy) {
        const report = PortfolioStrategy.evaluate(strategy);
        const missing = PortfolioStrategy.missingTopics(strategy);
        const isDraft = missing.length > 0;
        const hasAssistant = typeof AgentUI !== 'undefined';

        return `
            <div class="portfolio-strategy-detail" data-strategy-id="${strategy.id}">

                <header class="portfolio-strategy-head">
                    <div>
                        <h2>${AppManager.escapeHtml(strategy.name)}</h2>
                        <div class="portfolio-strategy-head-meta">
                            ${strategy.isDefault ? '<span class="portfolio-strategy-pill is-default">Overall strategy</span>' : ''}
                            ${isDraft ? '<span class="portfolio-strategy-pill is-draft">Unfinished</span>' : (report && !report.empty ? this._statusPill(report.status) : '')}
                            ${strategy.reviewCadence ? `<span class="portfolio-strategy-meta-item">Review ${AppManager.escapeHtml(strategy.reviewCadence.toLowerCase())}</span>` : ''}
                            ${strategy.updatedAt ? `<span class="portfolio-strategy-meta-item">Last discussed ${this._ago(strategy.updatedAt)}</span>` : ''}
                        </div>
                    </div>
                    <div class="portfolio-strategy-head-actions">
                        ${!strategy.isDefault ? `<button type="button" class="secondary-btn" data-strategy-action="make-default">Make overall</button>` : ''}
                        <button type="button" class="secondary-btn" data-strategy-action="delete">Delete</button>
                    </div>
                </header>

                ${isDraft ? this._draftBanner(strategy, missing, hasAssistant) : ''}

                ${this._proseHtml(strategy)}

                ${report && !report.empty ? this._reportHtml(report) : `
                    <p class="portfolio-strategy-note">Nothing is held in these accounts yet, so there is nothing to measure against the plan.</p>
                `}

                ${this._accountsHtml(strategy)}

                ${hasAssistant ? `
                    <section class="portfolio-strategy-section">
                        <h3>Work on this with Anjadhe</h3>
                        <p class="portfolio-strategy-section-sub">This strategy is changed by talking it through, not by editing fields. Anjadhe has your actual holdings in front of it.</p>
                        <div class="portfolio-strategy-chat-actions">
                            <button type="button" class="secondary-btn" data-strategy-action="refine">Refine it</button>
                            <button type="button" class="secondary-btn" data-strategy-action="validate">Stress-test it</button>
                            ${report && !report.empty && report.status !== 'on-track'
                                ? `<button type="button" class="secondary-btn" data-strategy-action="explain">Why am I off plan?</button>
                                   <button type="button" class="secondary-btn" data-strategy-action="rebalance">How do I get back on plan?</button>`
                                : ''}
                        </div>
                    </section>
                ` : ''}

                ${this._historyHtml(strategy)}
            </div>
        `;
    },

    _draftBanner(strategy, missing, hasAssistant) {
        const next = PortfolioStrategy.topic(missing[0]);
        return `
            <div class="portfolio-strategy-banner">
                <div>
                    <strong>Still being worked out.</strong>
                    ${next ? ` Next up: ${AppManager.escapeHtml(next.question)}` : ''}
                    <span class="portfolio-strategy-banner-sub">Until it is finished, Anjadhe will not measure your holdings against it.</span>
                </div>
                ${hasAssistant ? `<button type="button" class="primary-btn" data-strategy-action="resume">Continue</button>` : ''}
            </div>
        `;
    },

    _proseHtml(strategy) {
        const rows = [
            ['What it is for', strategy.objective],
            ['Horizon', strategy.horizon],
            ['Risk I can hold through', strategy.riskLevel],
            ['Approach', strategy.thesis],
            ['Covers', strategy.coverage]
        ].filter(([, v]) => v && String(v).trim());
        if (!rows.length) return '';
        return `
            <section class="portfolio-strategy-section">
                <h3>The plan</h3>
                <dl class="portfolio-strategy-prose">
                    ${rows.map(([label, value]) => `
                        <dt>${label}</dt>
                        <dd>${AppManager.escapeHtml(String(value))}</dd>
                    `).join('')}
                </dl>
            </section>
        `;
    },

    _reportHtml(report) {
        // Whole dollars: a rebalancing hint is an order of magnitude, and
        // "trim $14,379.70" reads as a precision the number does not have.
        const money = (v) => PortfolioUI.hv('$' + Math.round(Math.abs(v)).toLocaleString('en-US'));
        return `
            ${report.targets.length ? `
            <section class="portfolio-strategy-section">
                <h3>Target mix</h3>
                <table class="portfolio-strategy-table">
                    <thead>
                        <tr><th>Sleeve</th><th class="num">Target</th><th class="num">Actual</th><th>Status</th><th class="num">To get back</th></tr>
                    </thead>
                    <tbody>
                        ${report.targets.map(t => `
                            <tr class="is-${t.status}">
                                <td>
                                    <span class="portfolio-strategy-sleeve">${AppManager.escapeHtml(t.label)}</span>
                                    ${t.tickers.length ? `<span class="portfolio-strategy-sleeve-tickers">${AppManager.escapeHtml(t.tickers.slice(0, 8).join(', '))}${t.tickers.length > 8 ? ` +${t.tickers.length - 8}` : ''}</span>` : ''}
                                    ${t.includeCash ? '<span class="portfolio-strategy-sleeve-tickers">includes cash</span>' : ''}
                                </td>
                                <td class="num">${t.targetPct}%<span class="portfolio-strategy-band">${t.minPct}&ndash;${t.maxPct}</span></td>
                                <td class="num">${t.actualPct.toFixed(1)}%</td>
                                <td>${this._targetStatus(t)}</td>
                                <td class="num">${Math.abs(t.deltaValue) < 1 ? '&mdash;' : `${t.deltaValue > 0 ? 'add' : 'trim'} ${money(t.deltaValue)}`}</td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
                ${report.unclassified ? `
                    <p class="portfolio-strategy-note is-warn">
                        ${report.unclassified.pct.toFixed(0)}% of the portfolio is not covered by any sleeve${report.unclassified.tickers.length ? `: ${AppManager.escapeHtml(report.unclassified.tickers.join(', '))}` : ''}${report.unclassified.includesCash ? (report.unclassified.tickers.length ? ', plus cash' : ': cash') : ''}.
                    </p>
                ` : ''}
            </section>
            ` : ''}

            ${report.rules.length ? `
            <section class="portfolio-strategy-section">
                <h3>Guardrails</h3>
                <ul class="portfolio-strategy-rules">
                    ${report.rules.map(r => `
                        <li class="is-${r.status}">
                            <span class="portfolio-strategy-rule-mark">${r.status === 'ok' ? '&#10003;' : (r.status === 'breach' ? '&#9888;' : '&#8226;')}</span>
                            <span class="portfolio-strategy-rule-body">
                                <span class="portfolio-strategy-rule-label">${AppManager.escapeHtml(r.label)}</span>
                                <span class="portfolio-strategy-rule-detail">${AppManager.escapeHtml(r.detail)}</span>
                            </span>
                        </li>
                    `).join('')}
                </ul>
            </section>
            ` : ''}

            ${report.unpriced.length ? `
                <p class="portfolio-strategy-note">No current price for ${AppManager.escapeHtml(report.unpriced.join(', '))}, so ${report.unpriced.length === 1 ? 'it is' : 'they are'} not counted in the percentages above.</p>
            ` : ''}
        `;
    },

    _targetStatus(t) {
        if (t.status === 'ok') return '<span class="portfolio-strategy-tag is-ok">in band</span>';
        const dir = t.status === 'over' ? 'over' : 'under';
        return `<span class="portfolio-strategy-tag is-${t.status}">${Math.abs(t.driftPct).toFixed(0)}pt ${dir}</span>`;
    },

    /**
     * Which accounts run this plan. The selector here is structural (not
     * content), so it stays in the UI: picking which strategy an account
     * follows is a filing decision, not a conversation.
     */
    _accountsHtml(strategy) {
        const accounts = PortfolioApp.getAccounts() || [];
        if (!accounts.length) return '';
        const strategies = PortfolioStrategy.all();
        return `
            <section class="portfolio-strategy-section">
                <h3>Accounts</h3>
                <p class="portfolio-strategy-section-sub">An account follows the overall strategy unless you give it its own.</p>
                <ul class="portfolio-strategy-accounts">
                    ${accounts.map(a => {
                        const { strategy: applied, inherited } = PortfolioStrategy.forAccount(a.id);
                        return `
                            <li>
                                <button type="button" class="portfolio-strategy-account-name" data-strategy-account="${a.id}">${AppManager.escapeHtml(a.name)}</button>
                                <select class="portfolio-strategy-account-select" data-strategy-assign="${a.id}">
                                    <option value="">Follow the overall strategy</option>
                                    ${strategies.map(s => `
                                        <option value="${s.id}" ${a.strategyId === s.id ? 'selected' : ''}>${AppManager.escapeHtml(s.name)}</option>
                                    `).join('')}
                                </select>
                                ${applied ? `<span class="portfolio-strategy-account-tag">${inherited ? 'inheriting' : 'own plan'} &middot; ${AppManager.escapeHtml(applied.name)}</span>` : ''}
                            </li>
                        `;
                    }).join('')}
                </ul>
            </section>
        `;
    },

    /**
     * The change log. This is what makes the strategy something that was
     * discussed and revised rather than a document that appeared once.
     */
    _historyHtml(strategy) {
        const history = (strategy.history || []).slice(0, 8);
        if (!history.length) return '';
        return `
            <section class="portfolio-strategy-section">
                <h3>How it has changed</h3>
                <ul class="portfolio-strategy-history">
                    ${history.map(h => `
                        <li>
                            <span class="portfolio-strategy-history-when">${this._ago(h.at)}</span>
                            <span class="portfolio-strategy-history-what">${AppManager.escapeHtml(h.summary)}</span>
                        </li>
                    `).join('')}
                </ul>
            </section>
        `;
    },

    // ── Per-account strip (account detail view) ──────────────────────────

    renderAccountStrip(containerId, accountId) {
        const el = document.getElementById(containerId);
        if (!el || typeof PortfolioStrategy === 'undefined') return;
        const { strategy, inherited } = PortfolioStrategy.forAccount(accountId);
        if (!strategy) { this._hide(el); return; }

        const report = strategy.status === 'draft' ? null : PortfolioStrategy.evaluate(strategy, { accountId });
        el.style.display = '';
        el.innerHTML = `
            <div class="portfolio-strategy-card is-${report ? report.status : 'draft'}">
                <div class="portfolio-strategy-card-body">
                    <span class="portfolio-strategy-card-title">
                        ${AppManager.escapeHtml(strategy.name)}
                        ${inherited ? '<span class="portfolio-strategy-pill is-inherited">inherited</span>' : '<span class="portfolio-strategy-pill is-own">own plan</span>'}
                        ${report ? this._statusPill(report.status) : '<span class="portfolio-strategy-pill is-draft">Unfinished</span>'}
                    </span>
                    <p class="portfolio-strategy-card-sub">${report ? AppManager.escapeHtml(report.headline) : 'Finish it with Anjadhe to start tracking this account against it.'}</p>
                    ${report ? this._miniBars(report) : ''}
                </div>
                <div class="portfolio-strategy-card-actions">
                    <button type="button" class="portfolio-strategy-card-open" data-strategy-action="open" title="Open the Strategy page">&rarr;</button>
                </div>
            </div>
        `;
        this._wire(el, strategy, report, accountId);
    },

    // ── Wiring ───────────────────────────────────────────────────────────

    /**
     * Every action either opens the assistant with a fully-formed question
     * (content changes) or performs a structural change (default, assign,
     * delete). Nothing here edits the strategy's text or numbers directly.
     */
    _wire(root, strategy, report, accountId = null) {
        root.querySelectorAll('[data-strategy-tab]').forEach(tab => {
            tab.addEventListener('click', () => PortfolioApp.openStrategy(tab.dataset.strategyTab));
        });

        root.querySelectorAll('[data-strategy-account]').forEach(btn => {
            btn.addEventListener('click', () => PortfolioApp.openAccountDetail(btn.dataset.strategyAccount));
        });

        root.querySelectorAll('[data-strategy-assign]').forEach(select => {
            select.addEventListener('change', () => {
                PortfolioStrategy.assignAccount(select.dataset.strategyAssign, select.value || null);
                UIUtils.showToast('Account updated', 'success');
                PortfolioApp.renderStrategyView();
            });
        });

        root.querySelectorAll('[data-strategy-action]').forEach(btn => {
            btn.addEventListener('click', () => this._runAction(btn.dataset.strategyAction, strategy, report, accountId));
        });
    },

    async _runAction(action, strategy, report, accountId) {
        const ask = (prompt) => {
            if (typeof AgentUI === 'undefined') return;
            AgentUI.askWithPrompt(prompt, { newChat: true });
        };

        if (action === 'open') { PortfolioApp.openStrategy(strategy ? strategy.id : null); return; }

        if (action === 'interview') { ask(this.INTERVIEW_PROMPT); return; }

        if (action === 'resume') {
            ask(`Let's carry on building my investment strategy "${strategy.name}". ` +
                `Check what is still missing and ask me the next question.`);
            return;
        }

        if (action === 'make-default') {
            PortfolioStrategy.setDefault(strategy.id);
            UIUtils.showToast(`"${strategy.name}" is now the overall strategy`, 'success');
            PortfolioApp.renderStrategyView();
            return;
        }

        if (action === 'delete') {
            const confirmed = await UIUtils.confirm(
                'Delete strategy',
                `Delete "${strategy.name}"? Accounts following it will fall back to the overall strategy. This cannot be undone.`
            );
            if (!confirmed) return;
            PortfolioStrategy.remove(strategy.id);
            UIUtils.showToast('Strategy deleted', 'success');
            PortfolioApp.renderStrategyView();
            return;
        }

        const scope = accountId
            ? ` for my ${(PortfolioApp.getAccounts().find(a => a.id === accountId) || {}).name || ''} account`
            : '';

        if (action === 'review') {
            ask(`Review my portfolio${scope} against my strategy "${strategy.name}". ` +
                `Check where I actually stand versus the plan, and tell me plainly whether I am still following it.`);
            return;
        }

        if (action === 'refine') {
            ask(`I want to refine my investment strategy "${strategy.name}". ` +
                `Read it back to me first, then ask what I want to change and why. ` +
                `Push back if a change looks like I am reacting to a recent move rather than a change in my situation.`);
            return;
        }

        if (action === 'validate') {
            ask(`Stress-test my investment strategy "${strategy.name}". ` +
                `Look for what is vague, internally inconsistent, or unrealistic given my actual holdings, ` +
                `and tell me where it would fail me. Be blunt.`);
            return;
        }

        if (action === 'explain') {
            ask(`My portfolio${scope} is off my strategy "${strategy.name}": ${report ? report.headline : ''} ` +
                `Look at my holdings and explain how it drifted, and whether it drifted because of my decisions or because prices moved.`);
            return;
        }

        if (action === 'rebalance') {
            ask(`Show me how to get my portfolio${scope} back in line with my strategy "${strategy.name}". ` +
                `Use my real holdings and be specific about what to trim or add, including the tax and cost angle. ` +
                `Also tell me if doing nothing is the better call here.`);
            return;
        }
    },

    /** Coarse relative time — "3 days ago". */
    _ago(iso) {
        const then = new Date(iso).getTime();
        if (!Number.isFinite(then)) return '';
        const days = Math.floor((Date.now() - then) / 86400000);
        if (days <= 0) return 'today';
        if (days === 1) return 'yesterday';
        if (days < 30) return `${days} days ago`;
        const months = Math.floor(days / 30);
        if (months < 12) return `${months} month${months === 1 ? '' : 's'} ago`;
        const years = Math.floor(months / 12);
        return `${years} year${years === 1 ? '' : 's'} ago`;
    }
};
