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
 * TWO LEVELS (2026-09-30): the page opens on an OVERVIEW of compact cards,
 * one per plan, even when there is only one (verdict + counts, objective,
 * the mix as one strip, followers and last review; the whole card opens it),
 * and each plan has its own page with everything else. The list used to
 * render the full plan per entry, so the detail repeated it.
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
            // What the interview will ask, from the agenda itself — so the
            // one button is not a leap of faith.
            const agenda = (PortfolioStrategy.INTERVIEW || []).map((q, i) => `
                <li class="strategy-agenda-item">
                    <span class="strategy-agenda-n">${i + 1}</span>
                    <span class="strategy-agenda-main">
                        <span class="strategy-agenda-q">${esc(q.question)}</span>
                        <span class="strategy-agenda-why">${esc(String(q.why).split('. ')[0])}.</span>
                    </span>
                </li>`).join('');
            el.innerHTML = head(
                'The plan behind the holdings: what the money is for, the risk you can hold through, ' +
                'and the mix you are aiming at. You build it in conversation, nenva asks the questions.',
                `<div class="ask-prompt-row strategy-ask-row">
                    ${this._askBtn('Let’s build my investment strategy', this._interviewPrompt(), 'primary')}
                </div>`)
                + `<section class="strategy-agenda">
                    <div class="strategy-section-head">What it will ask</div>
                    <ol class="strategy-agenda-list">${agenda}</ol>
                    <p class="strategy-plan-note">Once saved, the page checks your actual holdings against the plan with plain arithmetic — the assistant explains, it never decides whether you are on plan.</p>
                </section>`
                + this._disclaimer();
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
            `${count} you build and change by asking. nenva reviews each one against what you actually hold.`,
            asks)
            + `<div class="strategy-overview">${strategies.map(s => this._overviewCard(s, accounts, esc)).join('')}</div>`
            + this._disclaimer();
        this._bind(el);
    },

    /**
     * One quiet line of standing fact at the foot of the page (the Terms of
     * Service carry the full clause). Point-of-use because a disclaimer only
     * on a legal page nobody opens is worth less than one beside the verdicts
     * it is about.
     */
    _disclaimer() {
        return '<p class="strategy-disclaimer">nenva is not an investment adviser. Strategy checks and reviews are information for your own decisions, not investment advice.</p>';
    },

    /**
     * One plan on the overview (2026-09-30): the answer to "how is it
     * doing?" at a glance, and the door to everything else. The list used
     * to carry the whole plan (verdict, properties, the full mix table,
     * guardrails, four buttons, the review), which made it the detail page
     * repeated once per plan and left the detail nothing of its own. Now the
     * card says the state (verdict + counts), what the plan is for (the
     * objective, clamped), the mix as one strip, and who follows it and when
     * it was last reviewed; the whole card opens the plan. No buttons and
     * no Delete here: every action lives on the plan's own page.
     */
    _overviewCard(s, accounts, esc) {
        const draft = (s.status || 'active') === 'draft';
        let report = null;
        try { report = PortfolioStrategy.evaluate(s); } catch (e) { report = null; }
        const measurable = !!((s.targets || []).length || (s.rules || []).length);

        // Followers, as a count (the detail page lists them).
        const own = accounts.filter(a => a.strategyId === s.id).length;
        const inherited = s.isDefault ? accounts.filter(a => !a.strategyId).length : 0;
        const n = own + inherited;
        const followers = n ? `${n} account${n === 1 ? '' : 's'}` : 'No accounts yet';

        // When nenva last reviewed it (the review routine's newest post).
        const routine = this._reviewRoutine(s);
        const post = routine ? this._latestReview(routine.id) : null;
        const reviewed = post && typeof PromptFeed !== 'undefined'
            ? `reviewed ${PromptFeed._timeAgo(post.createdAt)}`
            : (routine ? 'reviews scheduled' : '');

        let state;
        if (draft) {
            state = '<div class="strategy-ov-state"><span class="strategy-ov-word">Draft</span><span class="strategy-ov-counts">not finished yet</span></div>';
        } else if (measurable && report && !report.empty) {
            state = this._verdictLine(report, esc);
        } else if (measurable) {
            state = '<div class="strategy-ov-state"><span class="strategy-ov-counts">Not measured yet</span></div>';
        } else {
            state = '<div class="strategy-ov-state"><span class="strategy-ov-counts">No targets or guardrails to check yet</span></div>';
        }

        return `
            <article class="strategy-ov-card" data-open-strategy="${esc(s.id)}" role="button" tabindex="0"
                     title="Open this plan">
                <div class="strategy-ov-head">
                    <h3 class="strategy-ov-name">${esc(s.name)}</h3>
                    ${s.isDefault ? '<span class="strategy-card-tag">overall plan</span>' : ''}
                </div>
                ${state}
                ${s.objective ? `<p class="strategy-ov-objective">${esc(s.objective)}</p>` : ''}
                ${this._mixStrip(s, report, esc)}
                <div class="strategy-ov-foot">
                    ${[esc(followers), esc(reviewed)].filter(Boolean).join(' · ')}
                </div>
            </article>`;
    },

    /**
     * The verdict as one line for the overview card: the word in its state
     * colour, then the engine's counts. The full sentence lives on the plan.
     */
    _verdictLine(report, esc) {
        const words = { 'on-track': 'On plan', drift: 'Drifting', breach: 'Off plan' };
        const targets = report.targets || [];
        const rules = (report.rules || []).filter(r => r.status !== 'judgment');
        const broken = rules.filter(r => r.status === 'breach').length;
        const counts = [
            targets.length ? `${targets.filter(t => t.status === 'ok').length} of ${targets.length} sleeve${targets.length === 1 ? '' : 's'} in band` : '',
            rules.length ? (broken ? `${broken} guardrail${broken === 1 ? '' : 's'} broken` : 'guardrails held') : ''
        ].filter(Boolean).join(' · ');
        return `
            <div class="strategy-ov-state" data-status="${esc(report.status)}">
                <span class="strategy-ov-word">${words[report.status] || 'On plan'}</span>
                ${counts ? `<span class="strategy-ov-counts">${esc(counts)}</span>` : ''}
            </div>`;
    },

    /**
     * The mix as one strip: the actual allocation by sleeve, end to end,
     * with a tick wherever the targets say a boundary should fall, and a
     * sleeve outside its band in amber (state, never identity). The slice
     * no sleeve claims ("Not in the plan") closes the strip. Below it, the
     * sleeves by name with actual / target. Unpriced, it shows targets only.
     */
    _mixStrip(s, report, esc) {
        const planned = s.targets || [];
        if (!planned.length) return '';
        const priced = !!(report && !report.empty);
        const scored = priced ? (report.targets || []) : [];
        const stray = priced && report.unclassified ? report.unclassified.pct : 0;
        const rows = planned.map((t, i) => {
            const r = scored[i] || null;
            return { label: t.label, target: t.targetPct || 0, actual: r ? (r.actualPct || 0) : null, off: !!(r && r.status && r.status !== 'ok') };
        });
        const width = (v) => `${Math.max(0, Math.min(100, v))}%`;

        // Segments are the actual mix when priced, the target mix when not.
        const segs = rows.map(r => {
            const v = priced ? r.actual : r.target;
            return v > 0 ? `<span class="strategy-strip-seg${r.off ? ' is-off' : ''}" style="width:${width(v)}" title="${esc(r.label)}"></span>` : '';
        }).join('') + (priced && stray > 0 ? `<span class="strategy-strip-seg is-stray" style="width:${width(stray)}" title="Not in the plan"></span>` : '');

        // Target boundaries: the running sum of the targets, between sleeves.
        let run = 0;
        const ticks = priced ? rows.slice(0, -1).map(r => {
            run += r.target;
            return `<span class="strategy-strip-tick" style="left:${width(run)}"></span>`;
        }).join('') : '';

        const legend = rows.map(r => `
            <span class="strategy-strip-key${r.off ? ' is-off' : ''}">
                <span class="strategy-strip-label">${esc(r.label)}</span>
                <span class="strategy-strip-pct">${priced ? `${this._pct(r.actual)} of ${this._pct(r.target)}` : `${this._pct(r.target)}`}</span>
            </span>`).join('')
            + (priced && stray > 0 ? `
            <span class="strategy-strip-key is-stray">
                <span class="strategy-strip-label">Not in the plan</span>
                <span class="strategy-strip-pct">${this._pct(stray)}</span>
            </span>` : '');

        return `
            <div class="strategy-strip-wrap">
                <div class="strategy-strip" aria-hidden="true">${segs}${ticks}</div>
                <div class="strategy-strip-legend">${legend}</div>
            </div>`;
    },

    // ── The detail page (the name's door since 2026-08-06) ───────────────

    /**
     * One plan as its own page, everything the record holds, in the order
     * the questions come (2026-09-30): how is it doing (the verdict, with
     * the questions about it right under it rather than at the foot of a
     * long page) → the mix → the guardrails → what the plan is for (prose
     * you read once, so below the numbers you check) → who follows it →
     * decisions → history. The review stays in the margin. The pills are
     * picked for THIS plan's state, and the open composer stays for the
     * question the page did not think of.
     */
    _detail(s, accounts, esc) {
        const draft = (s.status || 'active') === 'draft';

        let report = null;
        try { report = PortfolioStrategy.evaluate(s); } catch (e) { report = null; }
        const priced = !!(report && !report.empty);
        const measurable = !!((s.targets || []).length || (s.rules || []).length);
        const props = this._props(s, esc);

        // Horizon and risk are often whole sentences, so they are rows in
        // "About this plan", not fragments of this line.
        const meta = s.createdAt ? `since ${esc(this._when(s.createdAt))}` : '';

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
                    <div class="strategy-plan">
                        ${measurable ? this._verdict(report, esc) : ''}
                        <div class="ask-prompt-row strategy-ask-row strategy-detail-asks">${this._detailAsks(s, accounts, report, esc)}</div>
                        ${this._mix(s, report, priced, esc)}
                        ${this._rules(s, report, priced, esc)}
                        ${props ? `<section class="strategy-section">
                            <div class="strategy-section-head">About this plan</div>
                            ${props}
                        </section>` : ''}
                    </div>
                    ${this._followers(s, accounts, esc)}
                    ${this._decisions(s)}
                    ${this._changeLog(s, esc)}
                </div>
                <aside class="strategy-card-margin">${this._reviewMargin(s, esc)}</aside>
            </article>`
            + this._disclaimer();
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
            <div class="strategy-acct-row" data-type="${esc(a.type || 'other')}">
                <span class="portfolio-nav-icon strategy-acct-icon" aria-hidden="true">${PortfolioUI.ACCOUNT_TYPE_ICON(a.type || 'other')}</span>
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
                    <div class="ai-review-meta">nenva’s review · ${esc(when)}</div>
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
            <p class="strategy-margin-text">nenva can read this plan against your holdings on a schedule and write what it finds.</p>
            <div class="ai-review-foot">
                <button type="button" class="quiet-link-btn" data-start-reviews="${esc(s.id)}">Review it every weekday morning</button>
            </div>`;
    },

    // ── The plan, shown ──────────────────────────────────────────────────

    /**
     * "Am I on plan?" answered on the page. The pill of the same name stays,
     * because the verdict is a state and the pill is an explanation — what
     * drifted, whether it matters, what to do — which is the assistant's job.
     */
    _verdict(report, esc) {
        if (!report || report.empty) return '';
        const words = { 'on-track': 'On plan', drift: 'Drifting', breach: 'Off plan' };
        const word = words[report.status] || 'On plan';
        const icons = {
            'on-track': '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
            drift: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h4l3-7 4 14 3-7h4"/></svg>',
            breach: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.3 3.9 2.6 17a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>'
        };
        // The arithmetic behind the word: sleeves inside their band,
        // guardrails held — so "Drifting" says how much before the assistant
        // says why.
        const targets = report.targets || [];
        const rules = (report.rules || []).filter(r => r.status !== 'judgment');
        const counts = [
            targets.length ? `${targets.filter(t => t.status === 'ok').length} of ${targets.length} sleeve${targets.length === 1 ? '' : 's'} in band` : '',
            rules.length ? `${rules.filter(r => r.status === 'ok').length} of ${rules.length} guardrail${rules.length === 1 ? '' : 's'} held` : ''
        ].filter(Boolean).join(' · ');
        return `
            <div class="strategy-verdict" data-status="${esc(report.status)}">
                <span class="strategy-verdict-pill">${icons[report.status] || icons['on-track']}<span class="strategy-verdict-mark">${word}</span></span>
                <span class="strategy-verdict-body">
                    <span class="strategy-verdict-text">${esc(report.headline || '')}</span>
                    ${counts ? `<span class="strategy-verdict-counts">${esc(counts)}</span>` : ''}
                </span>
            </div>`;
    },

    /** The prose half of the record: horizon, risk, approach, coverage, cadence. */
    _props(s, esc) {
        const row = (label, value) => value
            ? `<div class="strategy-prop">
                   <span class="strategy-prop-label">${label}</span>
                   <span class="strategy-prop-value">${esc(value)}</span>
               </div>`
            : '';
        const rows = [
            row('Horizon', s.horizon),
            row('Risk', s.riskLevel),
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
            const drift = r.actualPct != null ? r.actualPct - r.targetPct : null;
            const nums = r.actualPct == null
                ? `<span class="strategy-mix-target">${this._pct(r.targetPct)} target</span>`
                : `<span class="strategy-mix-actual">${this._pct(r.actualPct)}</span>
                   <span class="strategy-mix-target">of ${this._pct(r.targetPct)}</span>
                   ${drift != null && Math.abs(drift) >= 0.5 ? `<span class="strategy-mix-drift">${drift > 0 ? '+' : '−'}${this._pct(Math.abs(drift))}</span>` : ''}`;

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
                <div class="strategy-mix-row${off ? ' is-off' : ''}" data-status="${esc(r.status || 'unmeasured')}">
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

        const marks = {
            ok: '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
            breach: '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
            judgment: '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/></svg>',
            unknown: '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/></svg>'
        };
        const html = planned.map(rule => {
            const r = byId.get(`${rule.kind}|${rule.text || ''}|${rule.value}`) || null;
            const status = r ? r.status : 'unknown';
            const label = r ? r.label : (rule.text || PortfolioStrategy.RULE_KINDS[rule.kind]?.label || 'Rule');
            return `
                <div class="strategy-rule" data-status="${esc(status)}">
                    <span class="strategy-rule-mark">${marks[status] || marks.unknown}</span>
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
        el.querySelectorAll('[data-open-strategy]').forEach(b => {
            b.addEventListener('click', () => this.open(b.dataset.openStrategy));
            b.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.open(b.dataset.openStrategy); }
            });
        });
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
        if (typeof ReviewRoutines === 'undefined') return null;
        // The id first (RoutineAbout): a review armed since references
        // survives renaming the strategy. The title is the fallback for
        // every one armed before.
        return (s && s.id ? ReviewRoutines.findFor('strategy', s.id) : null)
            || ReviewRoutines.find(this.REVIEW_PREFIX + s.name);
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
            interval: 'weekdays', time: '08:00', web: true, useContext: true,
            about: [{ type: 'strategy', id: s.id }]
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
