/**
 * Strategy page — the AI-native strategy surface (scope 'strategy' in the
 * Portfolio left nav).
 *
 * The design rule: THERE ARE NO FORMS HERE. Every action is a prompt-button
 * that opens the assistant with a question (AgentUI.askWithPrompt) — the
 * assistant's interview/save tools do the actual writing, exactly like the
 * removed 2026-07-30 strategy UI decided, but with a page to stand on.
 *
 * READING is a different question from writing, and since 2026-08-01 the page
 * answers it in UI rather than by prompt: the plan's own saved facts (approach,
 * coverage, target mix, guardrails) render as a quiet property list, a mix
 * table with bands, and a rule list — plus the computed verdict from
 * PortfolioStrategy.evaluate(). Asking the assistant to read a record back to
 * you is a poor substitute for showing it, and the numbers here are arithmetic
 * from the same engine the tools use, never model-written. What stays a prompt
 * is every CHANGE, plus the judgment a table cannot make ("am I on plan?"
 * explains the verdict the page already states).
 *
 * Daily reviews ride the routines machinery rather than a private scheduler:
 * "Review it every weekday" creates a routine titled "Strategy Review:
 * <name>" (weekdays 08:00, web + context — the same recipe as the starter
 * portfolio reviews, with catch-up and cross-Mac run dedupe already solved
 * there). The page shows the latest feed post from that routine as the
 * strategy's current AI explanation; the full post opens in the feed.
 * A renamed strategy orphans its routine (title match) — the page simply
 * offers to start reviews again, and the old routine remains visible on the
 * Routines page for cleanup.
 */
const PortfolioStrategyPage = {
    REVIEW_PREFIX: 'Strategy Review: ',

    /** The plan the user last pointed the assistant at (see askAbout). */
    focusedStrategyId: null,

    /** The plan opened as a detail page (clicked by name); null = the list. */
    _openId: null,

    hide() {
        const el = document.getElementById('portfolio-strategy-page');
        if (el) el.hidden = true;
        this.focusedStrategyId = null;
        this._openId = null;
        document.querySelector('#portfolio-view .portfolio-main')?.classList.remove('strategy-scope');
    },

    render() {
        const el = document.getElementById('portfolio-strategy-page');
        if (!el || typeof PortfolioStrategy === 'undefined') return;
        document.querySelector('#portfolio-view .portfolio-main')?.classList.add('strategy-scope');
        el.hidden = false;

        const esc = AppManager.escapeHtml;
        const strategies = PortfolioStrategy.all();
        const accounts = PortfolioApp.getAccounts() || [];

        // A plan opened by name renders as its own page. A stale id (deleted
        // here or on another Mac) falls back to the list rather than a blank.
        if (this._openId) {
            const open = strategies.find(s => s.id === this._openId);
            if (open) {
                el.innerHTML = this._detail(open, accounts, esc);
                this._bind(el);
                return;
            }
            this._openId = null;
        }

        // The page states its own name and what this surface is for. Without
        // it the pane opened on a bare row of pills with nothing to anchor
        // them — the quoted buttons read as chrome rather than as the way
        // you work here.
        const head = (sub, asks) => `
            <header class="strategy-head">
                <h2 class="strategy-title">Strategy</h2>
                <p class="strategy-sub">${sub}</p>
                ${asks}
            </header>`;

        if (!strategies.length) {
            el.innerHTML = head(
                'The plan behind the holdings: what the money is for, the risk you can hold through, ' +
                'and the mix you are aiming at. You build it in conversation, Anjadhe asks the questions.',
                `<div class="ask-prompt-row strategy-ask-row">
                    ${this._askBtn('Let’s build my investment strategy', this._interviewPrompt(), 'primary')}
                </div>`);
            this._bind(el);
            return;
        }

        const asks = `
            <div class="ask-prompt-row strategy-ask-row">
                ${strategies.length > 1 ? this._askBtn('How do my strategies fit together?', 'Review all my investment strategies together against my actual portfolio: are they consistent with each other, and am I on plan overall?') : ''}
                ${/* With one plan this is the same question as the card's own
                      "Which accounts follow this?" — asked twice, three
                      inches apart. */ ''}
                ${strategies.length > 1 ? this._askBtn('Which accounts follow which plan?', 'Which of my accounts follow which investment strategy? Show the mapping, flag any account without a plan, and help me assign strategies where they are missing.') : ''}
                ${this._askBtn('Build another strategy', 'Help me build a new, separate investment strategy in addition to the ones I have. Walk me through it one question at a time.')}
            </div>`;

        const count = `${strategies.length} plan${strategies.length === 1 ? '' : 's'}`;
        el.innerHTML = head(
            `${count} you build and change by asking. Anjadhe reviews each one against what you actually hold.`,
            asks)
            + `<div class="strategy-list">${strategies.map(s => this._card(s, accounts, esc)).join('')}</div>`;
        this._bind(el);
    },

    _card(s, accounts, esc) {
        const draft = (s.status || 'active') === 'draft';
        // Who follows this plan. Two different facts, so they are said as two
        // clauses rather than added up: accounts pointed at it deliberately,
        // and accounts that land on it only because they have no plan of
        // their own and this is the overall one. "2 accounts + 3 accounts by
        // default" read as arithmetic on one number and explained neither.
        const own = accounts.filter(a => a.strategyId === s.id).length;
        const inherited = s.isDefault ? accounts.filter(a => !a.strategyId).length : 0;
        const noPlan = (n) => `${n} ${n === 1 ? 'account with no plan of its own' : 'accounts with no plan of their own'}`;
        let followers;
        if (own && inherited) followers = `${own} account${own === 1 ? '' : 's'}, plus ${noPlan(inherited)}`;
        else if (own) followers = `${own} account${own === 1 ? '' : 's'}`;
        else if (inherited) followers = noPlan(inherited);
        else followers = 'no accounts yet';
        // The followers clause is the one part of the meta line that raises a
        // question ("by default" is a fallback rule a count can state but not
        // justify), so it is the part that clicks — same move as the title.
        // No pill repeats it.
        const whoPrompt =
            `Which of my accounts follow my investment strategy "${s.name}"? List them by name, and separate the ones ` +
            'assigned to it deliberately from the ones that land on it only because they have no plan of their own. ' +
            'Then offer to reassign any that should be following something else.';

        // "overall plan" is a standing property of the strategy, not a fact
        // about this reading of it — it sits next to the name as a marker,
        // leaving the meta line to describe the plan itself.
        const meta = [
            s.horizon ? esc(s.horizon) : '',
            s.riskLevel ? `${esc(s.riskLevel)} risk` : '',
            `<button type="button" class="strategy-card-link" data-ask="${esc(whoPrompt)}"
                     title="Ask Anjadhe which accounts follow this plan">${esc(followers)}</button>`
        ].filter(Boolean).join(' · ');

        // The margin column. What the user wrote is on the left; what Anjadhe
        // says about it is annotation beside it, which is why the review has
        // its own column and its own eyebrow rather than trailing the prose
        // as one more paragraph.
        const review = this._reviewMargin(s, esc);

        // The quoted pills are questions the page asks FOR you; the open
        // button is the one that hands you the composer with this plan as the
        // subject, for the question the page did not think of.
        const asks = (draft
            ? this._askBtn('Finish building it', `Let's carry on building my investment strategy "${s.name}". Check what is still missing and ask me the next question.`)
            : this._askBtn('Am I on plan?', `Am I still following my strategy "${s.name}"? Check my actual holdings against it with check_strategy and tell me plainly.`)
              + this._askBtn('Change something', `I want to change something about my investment strategy "${s.name}". Ask me what, and update it once we agree.`))
            + `<button type="button" class="ask-prompt-btn ask-prompt-open" data-ask-open="${esc(s.id)}">Ask about this strategy…</button>`;

        // Delete is real and irreversible, so it is not part of the resting
        // composition: it appears on hover or keyboard focus, the way the
        // widgets' chevrons do.
        return `
            <article class="strategy-card" data-strategy="${esc(s.id)}">
                <div class="strategy-card-main">
                    <div class="strategy-card-head">
                        <h3 class="strategy-card-name">
                            <button type="button" class="strategy-name-link" data-open-strategy="${esc(s.id)}"
                                    title="Open this plan">${esc(s.name)}</button>
                        </h3>
                        ${draft ? '<span class="strategy-chip">draft</span>' : ''}
                        ${s.isDefault ? '<span class="strategy-card-tag">overall plan</span>' : ''}
                        <button type="button" class="strategy-card-delete" data-delete="${esc(s.id)}"
                                title="Delete this plan">Delete</button>
                    </div>
                    ${s.objective ? `<p class="strategy-card-objective">${esc(s.objective)}</p>` : ''}
                    ${meta ? `<div class="strategy-card-meta">${meta}</div>` : ''}
                    ${this._planBody(s, esc)}
                    <div class="ask-prompt-row strategy-ask-row">${asks}</div>
                </div>
                <aside class="strategy-card-margin">${review}</aside>
            </article>`;
    },

    // ── The detail page (the name's door since 2026-08-06) ───────────────

    /**
     * One plan as its own page. Everything the record holds is on it: the
     * verdict, every prose property, the mix and guardrails (same renderers
     * as the card), plus the two things the card has no room for — the
     * actual accounts following it, and the plan's own change log. The
     * pills underneath are picked for THIS plan's state, and the open
     * composer stays for the question the page did not think of.
     */
    _detail(s, accounts, esc) {
        const draft = (s.status || 'active') === 'draft';

        let report = null;
        try { report = PortfolioStrategy.evaluate(s); } catch (e) { report = null; }

        const meta = [
            s.horizon ? esc(s.horizon) : '',
            s.riskLevel ? `${esc(s.riskLevel)} risk` : '',
            s.createdAt ? `since ${esc(this._when(s.createdAt))}` : ''
        ].filter(Boolean).join(' · ');

        return `
            <button type="button" class="strategy-back" data-back>&#8592; Strategy</button>
            <article class="strategy-card is-detail" data-strategy="${esc(s.id)}">
                <div class="strategy-card-main">
                    <div class="strategy-card-head">
                        <h3 class="strategy-card-name">${esc(s.name)}</h3>
                        ${draft ? '<span class="strategy-chip">draft</span>' : ''}
                        ${s.isDefault ? '<span class="strategy-card-tag">overall plan</span>' : ''}
                        <button type="button" class="strategy-card-delete" data-delete="${esc(s.id)}"
                                title="Delete this plan">Delete</button>
                    </div>
                    ${s.objective ? `<p class="strategy-card-objective">${esc(s.objective)}</p>` : ''}
                    ${meta ? `<div class="strategy-card-meta">${meta}</div>` : ''}
                    ${this._planBody(s, esc)}
                    ${this._followers(s, accounts, esc)}
                    ${this._decisions(s)}
                    ${this._changeLog(s, esc)}
                    <div class="ask-prompt-row strategy-ask-row">${this._detailAsks(s, accounts, report, esc)}</div>
                </div>
                <aside class="strategy-card-margin">${this._reviewMargin(s, esc)}</aside>
            </article>`;
    },

    /**
     * The accounts actually judged against this plan — the followers clause
     * on the card, answered as a list instead of a question. Each row is a
     * door to that account's own scope; the inherited ones say why they are
     * here, because "follows it by default" is the rule people forget.
     */
    _followers(s, accounts, esc) {
        const own = accounts.filter(a => a.strategyId === s.id);
        const inherited = s.isDefault ? accounts.filter(a => !a.strategyId) : [];
        if (!own.length && !inherited.length) {
            return `
                <section class="strategy-section">
                    <div class="strategy-section-head">Accounts</div>
                    <p class="strategy-plan-note">No accounts follow this plan yet.</p>
                </section>`;
        }
        const row = (a, note) => `
            <div class="strategy-acct-row">
                <button type="button" class="strategy-acct-name" data-goto-account="${esc(a.id)}"
                        title="Open this account">${esc(a.name || 'Untitled account')}</button>
                ${note ? `<span class="strategy-acct-note">${note}</span>` : ''}
            </div>`;
        return `
            <section class="strategy-section">
                <div class="strategy-section-head">Accounts on this plan</div>
                ${own.map(a => row(a, '')).join('')}
                ${inherited.map(a => row(a, 'no plan of its own — follows the overall plan')).join('')}
            </section>`;
    },

    /**
     * Decisions saved about this plan (DecisionsUI) — the standing
     * instructions settled in chat or added by hand: a deployment schedule,
     * a rebalance rule of thumb. Distinct from History below, which records
     * that the plan's FIELDS changed; a decision is what was agreed ABOUT
     * the plan. The section sits as History's sibling with the page's own
     * section chrome (bare: true — DecisionsUI's default header would put
     * two header styles side by side).
     */
    _decisions(s) {
        if (typeof DecisionsUI === 'undefined') return '';
        return `
            <section class="strategy-section">
                <div class="strategy-section-head">Decisions</div>
                ${DecisionsUI.renderSection(`strategy:${s.id}`, { bare: true })}
            </section>`;
    },

    /**
     * The plan's own change log (save() has recorded one since the first
     * save; this page is the first surface to show it). It is what makes a
     * strategy "vetted rather than just stored" — when it was created, and
     * every time it was discussed and changed since.
     */
    _changeLog(s, esc) {
        const entries = (s.history || []).slice(0, 8);
        if (!entries.length) return '';
        const rows = entries.map(h => `
            <div class="strategy-log-row">
                <span class="strategy-log-when">${esc(this._when(h.at))}</span>
                <span class="strategy-log-text">${esc(h.summary || '')}</span>
            </div>`).join('');
        const more = (s.history || []).length - entries.length;
        return `
            <section class="strategy-section">
                <div class="strategy-section-head">History</div>
                ${rows}
                ${more > 0 ? `<p class="strategy-plan-note">${more} earlier change${more === 1 ? '' : 's'} not shown.</p>` : ''}
            </section>`;
    },

    /**
     * Pills chosen for this plan's state — a draft asks to be finished, a
     * drifting plan asks how to get back, a plan nobody follows asks to be
     * assigned. Plain-language explanation is always offered: the page shows
     * the record, the assistant is how you come to understand it.
     */
    _detailAsks(s, accounts, report, esc) {
        const draft = (s.status || 'active') === 'draft';
        const off = !!(report && !report.empty && report.status !== 'on-track');
        const followed = accounts.some(a => a.strategyId === s.id) || (s.isDefault && accounts.some(a => !a.strategyId));

        const pills = [];
        if (draft) {
            pills.push(this._askBtn('Finish building it',
                `Let's carry on building my investment strategy "${s.name}". Check what is still missing and ask me the next question.`, 'primary'));
        } else {
            pills.push(this._askBtn('Am I on plan?',
                `Am I still following my strategy "${s.name}"? Check my actual holdings against it with check_strategy and tell me plainly.`));
        }
        if (off) {
            pills.push(this._askBtn('How do I get back on plan?',
                `My strategy "${s.name}" is showing drift or a broken rule. Using only check_strategy's computed numbers, tell me exactly what to trim or add, in which accounts, to get back inside the bands — and whether it is worth acting on now or letting ride.`));
        }
        pills.push(this._askBtn('Explain this plan in plain language',
            `Explain my investment strategy "${s.name}" in plain language: what it is trying to do, what the target mix means in practice, and what each guardrail protects me from. Assume I am not a finance person.`));
        if (!draft) {
            pills.push(this._askBtn('Change something',
                `I want to change something about my investment strategy "${s.name}". Ask me what, and update it once we agree.`));
        }
        if (!followed) {
            pills.push(this._askBtn('Which accounts should follow this?',
                `No accounts follow my investment strategy "${s.name}" yet. Look at my accounts and what this plan covers, suggest which should follow it, and assign them once I agree.`));
        }
        pills.push(`<button type="button" class="ask-prompt-btn ask-prompt-open" data-ask-open="${esc(s.id)}">Ask about this strategy…</button>`);
        return pills.join('');
    },

    /** Short date for the meta line and the change log. */
    _when(iso) {
        const d = new Date(iso);
        if (isNaN(d)) return '';
        return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    },

    /** The review margin — shared between the list card and the detail. */
    _reviewMargin(s, esc) {
        const routine = this._reviewRoutine(s);
        const post = routine ? this._latestReview(routine.id) : null;

        if (post) {
            const when = typeof PromptFeed !== 'undefined' ? PromptFeed._timeAgo(post.createdAt) : '';
            return `
                <div class="ai-review-quote" data-open-post="${esc(post.id)}" role="button" tabindex="0"
                     title="Read the full review">
                    <div class="ai-review-meta">Anjadhe’s review · ${esc(when)}</div>
                    <p class="ai-review-text">${esc(ReviewRoutines.excerpt(post))}</p>
                </div>
                <div class="ai-review-foot">
                    Runs ${esc(NotePrompts.scheduleLabel(NotePrompts.config(routine)))}
                    <button type="button" class="quiet-link-btn" data-stop-reviews="${esc(routine.id)}">Stop</button>
                </div>`;
        }
        if (routine) {
            return `
                <div class="ai-review-meta">Reviews</div>
                <p class="strategy-margin-text">Scheduled ${esc(NotePrompts.scheduleLabel(NotePrompts.config(routine)))}. The first one posts to your Home feed after it runs.</p>
                <div class="ai-review-foot">
                    <button type="button" class="quiet-link-btn" data-run-review="${esc(routine.id)}">Run it now</button>
                    <button type="button" class="quiet-link-btn" data-stop-reviews="${esc(routine.id)}">Stop</button>
                </div>`;
        }
        // An empty margin is an invitation, not a blank: it says what the
        // column is for and offers the one action that fills it.
        return `
            <div class="ai-review-meta">Reviews</div>
            <p class="strategy-margin-text">Anjadhe can read this plan against your holdings on a schedule and write what it finds.</p>
            <div class="ai-review-foot">
                <button type="button" class="quiet-link-btn" data-start-reviews="${esc(s.id)}">Review it every weekday morning</button>
            </div>`;
    },

    // ── The plan, shown ──────────────────────────────────────────────────

    /**
     * The saved plan as UI: prose properties, the target mix against what is
     * actually held, and the guardrails with their computed verdict.
     *
     * Every number here comes from PortfolioStrategy.evaluate() — the same
     * arithmetic the check_strategy tool and the home widget use — so the page,
     * the assistant and the widget cannot disagree. Nothing on this surface is
     * written by a model, and nothing on it is editable: changes go through the
     * prompt-buttons underneath.
     */
    _planBody(s, esc) {
        let report = null;
        try { report = PortfolioStrategy.evaluate(s); } catch (e) { report = null; }
        const priced = !!(report && !report.empty);

        // A plan with no targets and no guardrails has nothing to be measured
        // against, and the engine's cheerful default ("Holdings match the
        // plan.") would be a verdict on an empty rulebook.
        const measurable = !!((s.targets || []).length || (s.rules || []).length);

        const sections = [
            measurable ? this._verdict(report, esc) : '',
            this._props(s, esc),
            this._mix(s, report, priced, esc),
            this._rules(s, report, priced, esc)
        ].filter(Boolean);

        return sections.length ? `<div class="strategy-plan">${sections.join('')}</div>` : '';
    },

    /**
     * "Am I on plan?" answered on the page. The pill of the same name stays,
     * because the verdict is a state and the pill is an explanation — what
     * drifted, whether it matters, what to do — which is the assistant's job.
     */
    _verdict(report, esc) {
        if (!report || report.empty) return '';
        const words = { 'on-track': 'On plan', drift: 'Drifting', breach: 'Off plan' };
        const word = words[report.status] || 'On plan';
        return `
            <div class="strategy-verdict" data-status="${esc(report.status)}">
                <span class="strategy-verdict-mark">${word}</span>
                <span class="strategy-verdict-text">${esc(report.headline || '')}</span>
            </div>`;
    },

    /** The prose half of the record: approach, coverage, cadence. */
    _props(s, esc) {
        const row = (label, value) => value
            ? `<div class="strategy-prop">
                   <span class="strategy-prop-label">${label}</span>
                   <span class="strategy-prop-value">${esc(value)}</span>
               </div>`
            : '';
        const rows = [
            row('Approach', s.thesis),
            row('Covers', s.coverage),
            row('Revisit', s.reviewCadence)
        ].filter(Boolean).join('');
        return rows ? `<div class="strategy-props">${rows}</div>` : '';
    },

    /**
     * The target mix. One row per sleeve: what it is, what it should be, what
     * it is, and a bar carrying the tolerance band so drift is visible without
     * doing subtraction in your head.
     *
     * All bars share one scale (the largest number on the card) so the rows are
     * comparable with each other — a per-row scale would draw a 5% sleeve and a
     * 70% sleeve the same width.
     */
    _mix(s, report, priced, esc) {
        const planned = s.targets || [];
        if (!planned.length) return '';

        const scored = priced ? report.targets : [];
        const rows = planned.map((t, i) => {
            const r = scored[i] || null;
            const min = t.minPct != null ? t.minPct : t.targetPct - PortfolioStrategy.DEFAULT_BAND;
            const max = t.maxPct != null ? t.maxPct : t.targetPct + PortfolioStrategy.DEFAULT_BAND;
            return {
                label: t.label,
                tickers: (t.tickers || []).map(x => PortfolioApp.displayTicker(x)),
                includeCash: !!t.includeCash,
                targetPct: t.targetPct,
                minPct: r ? r.minPct : min,
                maxPct: r ? r.maxPct : max,
                actualPct: r ? r.actualPct : null,
                status: r ? r.status : null,
                deltaValue: r ? r.deltaValue : null
            };
        });

        const stray = priced && report.unclassified ? report.unclassified : null;
        const scale = Math.max(
            10,
            ...rows.map(r => Math.max(r.targetPct || 0, r.maxPct || 0, r.actualPct || 0)),
            stray ? stray.pct : 0
        );
        const at = (v) => `${Math.min(100, Math.max(0, (v / scale) * 100))}%`;

        const html = rows.map(r => {
            const off = r.status && r.status !== 'ok';
            const nums = r.actualPct == null
                ? `<span class="strategy-mix-target">${this._pct(r.targetPct)} target</span>`
                : `<span class="strategy-mix-actual">${this._pct(r.actualPct)}</span>
                   <span class="strategy-mix-target">of ${this._pct(r.targetPct)}</span>`;

            // What it would take to get back to the middle of the band. The
            // actionable half of a drift report, and the only money on the page
            // — so it respects the hide-values toggle like every other figure.
            let note = '';
            if (off && r.deltaValue != null && Math.abs(r.deltaValue) >= 1) {
                const verb = r.deltaValue > 0 ? 'Add' : 'Trim';
                note = `${verb} ${PortfolioUI.hv(PortfolioUI.formatMoney(Math.abs(r.deltaValue)))} to reach target`;
            }

            // What the sleeve is made of. A cash-only sleeve is already named
            // by its label, so it gets no scope line repeating the word.
            const scope = [
                r.tickers.slice(0, 6).join(', '),
                r.tickers.length > 6 ? `+${r.tickers.length - 6} more` : '',
                r.includeCash && r.tickers.length ? 'and cash' : ''
            ].filter(Boolean).join(', ');

            return `
                <div class="strategy-mix-row${off ? ' is-off' : ''}">
                    <div class="strategy-mix-head">
                        <span class="strategy-mix-label">${esc(r.label)}</span>
                        <span class="strategy-mix-nums">${nums}</span>
                    </div>
                    <div class="strategy-bar">
                        <span class="strategy-bar-band" style="left:${at(r.minPct)};width:${at(Math.max(0, r.maxPct - r.minPct))}"></span>
                        ${r.actualPct == null ? '' : `<span class="strategy-bar-fill" style="width:${at(r.actualPct)}"></span>`}
                        <span class="strategy-bar-tick" style="left:${at(r.targetPct)}"></span>
                    </div>
                    ${scope || note ? `<div class="strategy-mix-foot">
                        ${scope ? `<span class="strategy-mix-scope">${esc(scope)}</span>` : ''}
                        ${note ? `<span class="strategy-mix-note">${esc(note)}</span>` : ''}
                    </div>` : ''}
                </div>`;
        }).join('');

        // A growing slice the plan never mentioned is itself a finding, so it
        // gets a row rather than being left out of the picture.
        const strayRow = stray ? `
            <div class="strategy-mix-row is-stray">
                <div class="strategy-mix-head">
                    <span class="strategy-mix-label">Not in the plan</span>
                    <span class="strategy-mix-nums"><span class="strategy-mix-actual">${this._pct(stray.pct)}</span></span>
                </div>
                <div class="strategy-bar">
                    <span class="strategy-bar-fill is-stray" style="width:${at(stray.pct)}"></span>
                </div>
                <div class="strategy-mix-foot">
                    <span class="strategy-mix-scope">${esc([stray.tickers.join(', '), stray.includesCash ? 'cash' : ''].filter(Boolean).join(', '))}</span>
                </div>
            </div>` : '';

        const unpriced = (priced && report.unpriced && report.unpriced.length)
            ? `<p class="strategy-plan-note">No price yet for ${esc(report.unpriced.slice(0, 6).join(', '))} — those are counted as zero here.</p>`
            : '';

        return `
            <section class="strategy-section">
                <div class="strategy-section-head">Target mix${priced ? '' : ' <span class="strategy-section-aside">not measured yet</span>'}</div>
                ${html}${strayRow}${unpriced}
            </section>`;
    },

    /** Guardrails, with the engine's verdict on each. */
    _rules(s, report, priced, esc) {
        const planned = s.rules || [];
        if (!planned.length) return '';

        const scored = priced ? (report.rules || []) : [];
        const byId = new Map();
        scored.forEach(r => byId.set(`${r.kind}|${r.text}|${r.value}`, r));

        const marks = { ok: '&#10003;', breach: '&#9888;', judgment: '&#8226;' };
        const html = planned.map(rule => {
            const r = byId.get(`${rule.kind}|${rule.text || ''}|${rule.value}`) || null;
            const status = r ? r.status : 'unknown';
            const label = r ? r.label : (rule.text || PortfolioStrategy.RULE_KINDS[rule.kind]?.label || 'Rule');
            return `
                <div class="strategy-rule" data-status="${esc(status)}">
                    <span class="strategy-rule-mark">${marks[status] || '&#8226;'}</span>
                    <span class="strategy-rule-label">${esc(label)}</span>
                    ${r ? `<span class="strategy-rule-detail">${esc(r.detail)}</span>` : ''}
                </div>`;
        }).join('');

        return `
            <section class="strategy-section">
                <div class="strategy-section-head">Guardrails</div>
                ${html}
            </section>`;
    },

    /** Percentages read as whole numbers unless the sleeve is genuinely tiny. */
    _pct(v) {
        if (v == null) return '';
        return `${v < 1 && v > 0 ? v.toFixed(1) : Math.round(v)}%`;
    },

    // ── Prompt-buttons ──

    _askBtn(label, prompt, kind = '') {
        const esc = AppManager.escapeHtml;
        return `<button type="button" class="ask-prompt-btn${kind ? ` ${kind}` : ''}"
                    data-ask="${esc(prompt)}">“${esc(label)}”</button>`;
    },

    _interviewPrompt() {
        return 'Help me build an investment strategy for my portfolio. ' +
            'I am not sure what a strategy needs to cover, so please walk me through it one question at a time.';
    },

    /**
     * Open the assistant with this plan as the subject and the composer left
     * empty — the user's own question, not one of ours. The focused id is what
     * the AgentContext provider names as "this strategy", so the model knows
     * which plan is on screen before a word is typed.
     */
    askAbout(strategyId) {
        this.focusedStrategyId = strategyId || null;
        if (typeof AgentUI === 'undefined') return;
        AgentUI.openComposer();
    },

    /**
     * Open one plan as its own page. The focused id follows it, so the
     * AgentContext provider (and the floating "Ask about…" pill) name this
     * plan as the subject the whole time it is on screen.
     */
    open(strategyId) {
        this._openId = strategyId || null;
        this.focusedStrategyId = this._openId;
        this.render();
        // The document is the scroll container (html { overflow-y: scroll }),
        // and a name clicked far down the list should open at the top.
        window.scrollTo(0, 0);
    },

    back() {
        this._openId = null;
        this.focusedStrategyId = null;
        this.render();
    },

    _bind(el) {
        if (typeof DecisionsUI !== 'undefined' && this._openId) {
            DecisionsUI.attachListeners(el, `strategy:${this._openId}`, () => this.render());
        }
        el.querySelectorAll('[data-ask]').forEach(b =>
            b.addEventListener('click', () => AgentUI.askWithPrompt(b.dataset.ask, { newChat: true })));
        el.querySelectorAll('[data-open-strategy]').forEach(b =>
            b.addEventListener('click', () => this.open(b.dataset.openStrategy)));
        el.querySelector('[data-back]')?.addEventListener('click', () => this.back());
        el.querySelectorAll('[data-goto-account]').forEach(b =>
            b.addEventListener('click', () => PortfolioApp.openAccountDetail(b.dataset.gotoAccount)));
        el.querySelectorAll('[data-ask-open]').forEach(b =>
            b.addEventListener('click', () => this.askAbout(b.dataset.askOpen)));
        el.querySelectorAll('[data-delete]').forEach(b =>
            b.addEventListener('click', () => this._delete(b.dataset.delete)));
        el.querySelectorAll('[data-start-reviews]').forEach(b =>
            b.addEventListener('click', () => this._startReviews(b.dataset.startReviews)));
        el.querySelectorAll('[data-stop-reviews]').forEach(b =>
            b.addEventListener('click', () => this._stopReviews(b.dataset.stopReviews)));
        el.querySelectorAll('[data-run-review]').forEach(b =>
            b.addEventListener('click', async () => {
                if (typeof PromptFeed === 'undefined' || !PromptFeed.runNow) return;
                b.disabled = true;
                b.textContent = 'Running…';
                await PromptFeed.runNow(b.dataset.runReview);
                this.render();
            }));
        el.querySelectorAll('[data-open-post]').forEach(b => {
            const open = () => { if (typeof PromptFeed !== 'undefined') PromptFeed.openPost(b.dataset.openPost); };
            b.addEventListener('click', open);
            b.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
        });
    },

    // ── Daily reviews (shared ReviewRoutines plumbing) ──

    _reviewRoutine(s) {
        return (typeof ReviewRoutines !== 'undefined')
            ? ReviewRoutines.find(this.REVIEW_PREFIX + s.name) : null;
    },

    _latestReview(promptId) {
        return (typeof ReviewRoutines !== 'undefined')
            ? ReviewRoutines.latestPost(promptId) : null;
    },

    _startReviews(strategyId) {
        const s = PortfolioStrategy.getById(strategyId);
        if (!s || typeof ReviewRoutines === 'undefined') return;
        const body =
            `Review my investment strategy "${s.name}" as of today. ` +
            `Call get_strategy and check_strategy for "${s.name}", refresh_portfolio_prices, and read my holdings with list_portfolio. ` +
            'Use web search for market context relevant to this strategy’s targets and my holdings (rates, sectors, major moves). ' +
            'Then write a short plain review: whether the strategy still fits current market conditions, any drift or breach using only check_strategy’s computed numbers, and what, if anything, deserves attention today. ' +
            'If nothing changed and nothing is off plan, say so in two sentences and stop.';
        ReviewRoutines.start({
            title: this.REVIEW_PREFIX + s.name, body,
            interval: 'weekdays', time: '08:00', web: true, useContext: true
        });
        UIUtils.showToast('Reviews scheduled for weekday mornings. Adjust anytime in Routines.', 'success');
        this.render();
    },

    /**
     * Delete a plan. The confirmation states the two consequences the engine
     * applies — accounts fall back to the overall plan, and a new overall is
     * promoted if this was it — because both are invisible until they bite.
     * The review routine is NOT deleted with it: past reviews are feed posts
     * the user may still want, so the dialog says where it went instead of
     * quietly taking it.
     */
    async _delete(strategyId) {
        const s = PortfolioStrategy.getById(strategyId);
        if (!s) return;
        const following = PortfolioStrategy.accountsUsing(s.id).length;
        const lines = [`“${AppManager.escapeHtml(s.name)}” and everything saved in it will be gone. This cannot be undone.`];
        if (following) {
            lines.push(`${following} account${following === 1 ? '' : 's'} following it will fall back to your overall plan.`);
        }
        if (s.isDefault) lines.push('Another plan becomes the overall one.');
        const routine = this._reviewRoutine(s);
        if (routine) lines.push('Its review routine stays in Routines, along with past reviews in your feed.');

        const ok = await UIUtils.confirm('Delete this plan?', lines.join('<br><br>'), '&#9888;',
            { confirmText: 'Delete plan' });
        if (!ok) return;

        PortfolioStrategy.remove(s.id);
        UIUtils.showToast(`Deleted “${s.name}”.`, 'success');
        // Deleting from the plan's own page: the page is gone with it.
        if (this._openId === s.id) { this._openId = null; this.focusedStrategyId = null; }
        this.render();
    },

    _stopReviews(routineId) {
        if (typeof ReviewRoutines === 'undefined') return;
        ReviewRoutines.stop(routineId);
        UIUtils.showToast('Daily reviews stopped. Past reviews stay in the feed.', 'success');
        this.render();
    }
};
