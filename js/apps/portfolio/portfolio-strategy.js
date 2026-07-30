/**
 * Portfolio Strategy
 *
 * An investment strategy the user arrived at by TALKING to the assistant, not
 * by filling in a form. Two halves, and both matter:
 *
 *   - the prose (purpose, horizon, risk, approach) — the reasoning that was
 *     actually discussed and vetted, in the user's own words;
 *   - the distilled numbers (targets, guardrails) — the assistant's read of
 *     that conversation, confirmed by the user before it is saved.
 *
 * The numbers are what make a strategy something you FOLLOW rather than
 * something you wrote once: adherence is computed here, in plain JS, so
 * "am I still on plan?" is arithmetic instead of an LLM judgment that varies
 * run to run (and would be shaky on a small local model). The model's job is
 * to run the interview, distill, and explain the drift — never to decide
 * whether the user is on plan.
 *
 * Storage rides in the `portfolio` blob (so it syncs between Macs like
 * everything else). Profile-aware, like accounts.
 */

const PortfolioStrategy = {

    /** Default half-width of a target's tolerance band, in percentage points. */
    DEFAULT_BAND: 5,

    /**
     * The interview agenda.
     *
     * This is the heart of the feature. Users generally do not know what a
     * strategy needs to contain — asking "what's your investment strategy?"
     * gets you a blank stare or "buy good companies". So the agenda is fixed
     * HERE, deterministically, and the assistant is handed it one topic at a
     * time with the reason each topic matters. A small local model can run a
     * competent intake off this; it cannot invent one.
     *
     * Order is deliberate: purpose and horizon constrain risk, risk
     * constrains the mix, and the mix is what guardrails protect. Asking for
     * an allocation before knowing the horizon produces a number the user
     * made up on the spot.
     */
    INTERVIEW: [
        {
            id: 'purpose',
            field: 'objective',
            required: true,
            question: 'What is this money for?',
            why: 'Everything else follows from the goal. Money you need for a house in three years and money you will not touch for thirty are not invested the same way, no matter what the market is doing.',
            examples: ['Retirement', 'A house down payment', 'College for the kids', 'General long-term wealth', 'Income to live on now']
        },
        {
            id: 'horizon',
            field: 'horizon',
            required: true,
            question: 'When do you expect to need it?',
            why: 'Time horizon sets how much short-term loss is survivable. A long horizon lets a drop recover; a short one does not, so the money has to be steadier.',
            examples: ['Under 3 years', '3 to 10 years', '10 to 20 years', '20+ years', 'Never, this is generational']
        },
        {
            id: 'risk',
            field: 'riskLevel',
            required: true,
            question: 'How big a drop could you sit through without selling?',
            why: 'This is the honest version of "what is your risk tolerance". The number that matters is not the one you accept in theory, it is the one you can watch happen and do nothing about. A plan you abandon in a bad month is worse than a duller plan you keep.',
            // Concrete framing beats the usual conservative/moderate/aggressive
            // labels, which mean whatever the user wants them to mean.
            examples: ['10% (I would be uneasy past that)', '20%', '30%', '40%+ (I have held through one before)'],
            enum: ['conservative', 'moderate', 'aggressive']
        },
        {
            id: 'approach',
            field: 'thesis',
            required: true,
            question: 'How do you want it invested, and what do you believe that makes you pick that?',
            why: 'The thesis is what you check a future trade against. Without it, every new idea looks reasonable in the moment.',
            examples: ['Broad index funds, keep costs low', 'Index core with a few conviction picks', 'Dividend payers for income', 'Concentrated in what I know well']
        },
        {
            id: 'allocation',
            field: 'targets',
            required: true,
            question: 'What mix are you aiming for?',
            why: 'A target mix turns the plan into something checkable. Without percentages, drift is invisible until it is extreme.',
            // The assistant should PROPOSE a mix from the answers above and the
            // user's actual holdings, then let the user adjust it — most people
            // cannot produce percentages cold, but they can react to a proposal.
            hint: 'Propose a mix based on their answers and what they already own, with rough bands, then let them adjust. Do not ask them to produce percentages unprompted.',
            examples: ['70% total-market index, 20% individual stocks, 10% cash', '60% stocks, 30% bonds, 10% cash']
        },
        {
            id: 'guardrails',
            field: 'rules',
            required: false,
            question: 'What limits do you want to hold yourself to?',
            why: 'Guardrails are the part that survives a bad decision. They are easiest to set now, calmly, and hardest to set in the moment you want to break them.',
            hint: 'Suggest the common ones rather than asking open-ended: a cap on any single position, a cash floor, anything they want to stay away from.',
            examples: ['No single stock over 15%', 'Keep at least 5% cash', 'No leveraged or inverse funds', 'No single-name biotech']
        },
        {
            id: 'review',
            field: 'reviewCadence',
            required: false,
            question: 'How often do you want to revisit this?',
            why: 'A strategy you never revisit becomes a strategy you have quietly stopped following.',
            examples: ['Monthly', 'Quarterly', 'Twice a year', 'Once a year']
        },
        {
            id: 'coverage',
            field: 'coverage',
            required: true,
            question: 'Does this cover everything, or only some accounts? And what should it be called?',
            why: 'A portfolio can run more than one plan. Retirement money and a trading account should not be judged against the same rules, and naming it makes it something you can point at later.',
            hint: 'Save under a short working name from their first answer at the start of the interview, and settle the real name here.',
            examples: ['Everything, call it Core Growth', 'Just the IRA and 401(k), call it Retirement']
        }
    ],

    /** Guardrail kinds the engine can check without an LLM. */
    RULE_KINDS: {
        max_position: { label: 'Max single position', unit: '%' },
        min_cash:     { label: 'Cash floor',          unit: '%' },
        max_cash:     { label: 'Cash ceiling',        unit: '%' },
        avoid:        { label: 'Stay away from',      unit: null },
        only:         { label: 'Only hold',           unit: null },
        custom:       { label: 'Rule',                unit: null }
    },

    // ── Storage ──────────────────────────────────────────────────────────

    /** All strategies in the active profile. */
    all() {
        PortfolioApp.loadData();
        const list = PortfolioApp.strategies || [];
        return list;
    },

    getById(id) {
        return this.all().find(s => s.id === id) || null;
    },

    /** Case-insensitive name match, then id. Used by the agent tools. */
    find(nameOrId) {
        if (!nameOrId) return null;
        const needle = String(nameOrId).trim().toLowerCase();
        const list = this.all();
        return list.find(s => s.id === nameOrId)
            || list.find(s => (s.name || '').toLowerCase() === needle)
            || list.find(s => (s.name || '').toLowerCase().includes(needle))
            || null;
    },

    /**
     * The overall strategy — the one accounts fall back to when they have not
     * been given their own. First one flagged default, else the only one.
     */
    getDefault() {
        const list = this.all();
        return list.find(s => s.isDefault) || (list.length === 1 ? list[0] : null);
    },

    /**
     * The strategy an account is actually judged against: its own if it has
     * one, otherwise the overall. `inherited` tells the UI which it is, so a
     * user can see at a glance whether an account is running the house plan
     * or its own.
     */
    forAccount(accountId) {
        // Never trust in-memory state: the assistant can add a transaction
        // while the user is looking at another app, and refreshApp only
        // reloads Portfolio when Portfolio is the visible app.
        PortfolioApp.loadData();
        const account = (PortfolioApp.getAccounts() || []).find(a => a.id === accountId);
        if (account && account.strategyId) {
            const own = this.getById(account.strategyId);
            if (own) return { strategy: own, inherited: false };
        }
        const fallback = this.getDefault();
        return fallback ? { strategy: fallback, inherited: true } : { strategy: null, inherited: false };
    },

    /**
     * Create or update a strategy, merging field by field.
     *
     * Merge (not replace) is what lets the interview save as it goes: the
     * assistant can persist the purpose after question one and the targets
     * after question five, and an interrupted conversation leaves a usable
     * draft instead of nothing. Only keys actually present in `patch` are
     * touched.
     */
    save(patch = {}) {
        PortfolioApp.loadData();
        const list = PortfolioApp.strategies || [];
        const now = new Date().toISOString();

        let strategy = patch.id ? list.find(s => s.id === patch.id) : null;
        if (!strategy && patch.name) {
            const needle = patch.name.trim().toLowerCase();
            strategy = list.find(s => (s.name || '').toLowerCase() === needle);
        }

        const isNew = !strategy;
        if (isNew) {
            strategy = {
                id: crypto.randomUUID(),
                name: patch.name || 'Untitled strategy',
                objective: '',
                horizon: '',
                riskLevel: '',
                thesis: '',
                coverage: '',
                targets: [],
                rules: [],
                reviewCadence: '',
                isDefault: list.length === 0,   // the first one is the overall
                createdAt: now,
                history: []
            };
            list.push(strategy);
        }

        const changed = [];
        for (const key of ['name', 'objective', 'horizon', 'riskLevel', 'thesis', 'reviewCadence', 'coverage']) {
            if (patch[key] !== undefined && patch[key] !== strategy[key]) {
                strategy[key] = patch[key];
                changed.push(key);
            }
        }
        if (patch.targets !== undefined) {
            strategy.targets = this._normalizeTargets(patch.targets);
            changed.push('targets');
        }
        if (patch.rules !== undefined) {
            strategy.rules = this._normalizeRules(patch.rules);
            changed.push('rules');
        }
        if (patch.isDefault === true) this._makeDefault(list, strategy);

        strategy.updatedAt = now;
        strategy.status = this.missingTopics(strategy).length ? 'draft' : 'active';

        // The change log is what makes a strategy "vetted" rather than just
        // stored: it records that this was discussed and when.
        if (changed.length) {
            strategy.history = strategy.history || [];
            strategy.history.unshift({
                at: now,
                summary: patch.changeNote
                    || (isNew ? 'Created' : `Updated ${changed.join(', ')}`)
            });
            strategy.history = strategy.history.slice(0, 50);
        }

        PortfolioApp.strategies = list;
        PortfolioApp.saveData();
        return strategy;
    },

    _makeDefault(list, strategy) {
        for (const s of list) s.isDefault = (s === strategy);
    },

    /** Promote a strategy to the overall one. */
    setDefault(id) {
        PortfolioApp.loadData();
        const list = PortfolioApp.strategies || [];
        const strategy = list.find(s => s.id === id);
        if (!strategy) return null;
        this._makeDefault(list, strategy);
        PortfolioApp.strategies = list;
        PortfolioApp.saveData();
        return strategy;
    },

    remove(id) {
        PortfolioApp.loadData();
        const list = PortfolioApp.strategies || [];
        const idx = list.findIndex(s => s.id === id);
        if (idx === -1) return false;
        const wasDefault = list[idx].isDefault;
        list.splice(idx, 1);
        // Accounts pointing at it fall back to the overall rather than
        // silently keeping a dangling id.
        for (const account of (PortfolioApp.accounts || [])) {
            if (account.strategyId === id) account.strategyId = null;
        }
        if (wasDefault && list.length) list[0].isDefault = true;
        PortfolioApp.strategies = list;
        PortfolioApp.saveData();
        return true;
    },

    /**
     * Point an account at a strategy. strategyId null = follow the overall.
     */
    assignAccount(accountId, strategyId) {
        PortfolioApp.loadData();
        const account = (PortfolioApp.accounts || []).find(a => a.id === accountId);
        if (!account) return null;
        account.strategyId = strategyId || null;
        PortfolioApp.saveData();
        return account;
    },

    /** Accounts currently judged against a given strategy. */
    accountsUsing(strategyId) {
        const strategy = this.getById(strategyId);
        if (!strategy) return [];
        return (PortfolioApp.getAccounts() || []).filter(a => {
            if (a.strategyId) return a.strategyId === strategyId;
            return !!strategy.isDefault;
        });
    },

    // ── Interview ────────────────────────────────────────────────────────

    /**
     * Which required topics a strategy still has nothing for. This drives the
     * interview: the assistant asks the FIRST missing topic, so the flow is
     * deterministic and resumable across turns (and across conversations —
     * a draft picked up next week continues where it stopped).
     */
    missingTopics(strategy) {
        if (!strategy) return this.INTERVIEW.filter(t => t.required).map(t => t.id);
        return this.INTERVIEW.filter(topic => {
            if (!topic.required) return false;
            const value = strategy[topic.field];
            if (Array.isArray(value)) return value.length === 0;
            return !value || !String(value).trim();
        }).map(t => t.id);
    },

    /** The agenda entry for a topic id. */
    topic(id) {
        return this.INTERVIEW.find(t => t.id === id) || null;
    },

    // ── Adherence engine ─────────────────────────────────────────────────

    /**
     * Score real holdings against a strategy.
     *
     * All arithmetic, no model. Returns a shape that serves both the UI cards
     * and the agent tool, so the number the user reads on screen and the
     * number the assistant talks about are the same number.
     *
     * @param {object} strategy
     * @param {object} [opts]  { accountId } to scope to one account
     */
    evaluate(strategy, opts = {}) {
        if (!strategy) return null;
        PortfolioApp.loadData();
        const accountId = opts.accountId || null;

        const holdings = PortfolioApp.computeHoldings(accountId) || [];
        const cash = PortfolioApp.computeTotalCash(accountId) || 0;
        const invested = holdings.reduce((sum, h) => sum + (h.currentValue || 0), 0);
        const total = invested + cash;

        // Unpriced positions would silently distort every percentage below,
        // so they are reported rather than quietly counted as zero.
        const unpriced = holdings.filter(h => !(h.currentPrice > 0))
            .map(h => PortfolioApp.displayTicker(h.ticker));

        if (!(total > 0)) {
            return {
                strategyId: strategy.id, strategyName: strategy.name,
                accountId, total: 0, empty: true,
                targets: [], rules: [], unclassified: null, unpriced,
                status: 'no-data', headline: 'Nothing to measure yet.'
            };
        }

        const pct = (value) => (value / total) * 100;
        const claimed = new Set();

        const targets = (strategy.targets || []).map(target => {
            const matched = holdings.filter(h => this._matchesTarget(h, target));
            matched.forEach(h => claimed.add(h.ticker));
            let value = matched.reduce((sum, h) => sum + (h.currentValue || 0), 0);
            if (target.includeCash) value += cash;

            const actualPct = pct(value);
            const min = target.minPct != null ? target.minPct : target.targetPct - this.DEFAULT_BAND;
            const max = target.maxPct != null ? target.maxPct : target.targetPct + this.DEFAULT_BAND;
            const status = actualPct < min ? 'under' : (actualPct > max ? 'over' : 'ok');
            // What it would take to get back to the middle of the band — the
            // actionable half of a drift report.
            const deltaValue = (target.targetPct / 100) * total - value;

            return {
                label: target.label,
                tickers: (target.tickers || []).map(t => PortfolioApp.displayTicker(t)),
                includeCash: !!target.includeCash,
                targetPct: target.targetPct,
                minPct: min, maxPct: max,
                actualPct, value, status, deltaValue,
                driftPct: actualPct - target.targetPct
            };
        });

        // Anything the plan does not account for. A growing unclassified
        // slice is itself a finding — it usually means buys drifted away from
        // what was agreed.
        const strays = holdings.filter(h => !claimed.has(h.ticker));
        const strayValue = strays.reduce((sum, h) => sum + (h.currentValue || 0), 0);
        const anyTargetTakesCash = (strategy.targets || []).some(t => t.includeCash);
        const unclassifiedValue = strayValue + (anyTargetTakesCash ? 0 : cash);
        const unclassified = (targets.length && unclassifiedValue > 0.005 * total) ? {
            pct: pct(unclassifiedValue),
            value: unclassifiedValue,
            tickers: strays.map(h => PortfolioApp.displayTicker(h.ticker)).slice(0, 12),
            includesCash: !anyTargetTakesCash && cash > 0
        } : null;

        const rules = (strategy.rules || [])
            .map(rule => this._checkRule(rule, { holdings, cash, total, pct }))
            .filter(Boolean);

        const breaches = rules.filter(r => r.status === 'breach').length;
        const drifted = targets.filter(t => t.status !== 'ok').length;
        const needsJudgment = rules.filter(r => r.status === 'judgment').length;

        let status = 'on-track';
        if (breaches) status = 'breach';
        else if (drifted) status = 'drift';

        return {
            strategyId: strategy.id,
            strategyName: strategy.name,
            accountId,
            total, cash, invested,
            targets, rules, unclassified, unpriced,
            counts: { drifted, breaches, needsJudgment },
            status,
            headline: this._headline(status, drifted, breaches, targets, rules)
        };
    },

    _headline(status, drifted, breaches, targets, rules) {
        if (status === 'breach') {
            const first = rules.find(r => r.status === 'breach');
            return first ? first.detail : `${breaches} rule${breaches === 1 ? '' : 's'} broken.`;
        }
        if (status === 'drift') {
            const worst = targets.filter(t => t.status !== 'ok')
                .sort((a, b) => Math.abs(b.driftPct) - Math.abs(a.driftPct))[0];
            return worst
                ? `${worst.label} is ${worst.actualPct.toFixed(0)}% against a ${worst.targetPct}% target.`
                : `${drifted} target${drifted === 1 ? '' : 's'} outside its band.`;
        }
        return 'Holdings match the plan.';
    },

    /**
     * A holding belongs to a target when its ticker is listed. Options match
     * on their underlying too, so a plan that says "AI names: NVDA" also
     * catches an NVDA call rather than dumping it in unclassified.
     */
    _matchesTarget(holding, target) {
        const list = (target.tickers || []).map(t => String(t).toUpperCase());
        if (!list.length) return false;
        const ticker = String(holding.ticker).toUpperCase();
        if (list.includes(ticker)) return true;
        const underlying = holding.option && holding.option.underlying;
        return !!underlying && list.includes(String(underlying).toUpperCase());
    },

    /**
     * Check one guardrail. `custom` rules are prose the engine cannot judge,
     * so they come back marked 'judgment' — the assistant reads those against
     * the holdings itself and says so, rather than the app pretending to a
     * verdict it did not compute.
     */
    _checkRule(rule, ctx) {
        const { holdings, cash, total, pct } = ctx;
        const base = { kind: rule.kind, text: rule.text || '', value: rule.value };

        if (rule.kind === 'max_position') {
            // "No position over 15%" nearly always means single stocks, not
            // the index fund that IS the core sleeve — so the rule can carry
            // exemptions, and the assistant is told to set them.
            const exempt = (rule.exclude || []).map(t => String(t).toUpperCase());
            const over = holdings
                .filter(h => !exempt.includes(String(h.ticker).toUpperCase())
                    && !exempt.includes(String((h.option && h.option.underlying) || '').toUpperCase()))
                .map(h => ({ ticker: PortfolioApp.displayTicker(h.ticker), p: pct(h.currentValue || 0) }))
                .filter(h => h.p > rule.value)
                .sort((a, b) => b.p - a.p);
            return {
                ...base,
                label: `No position over ${rule.value}%${exempt.length ? ` (excluding ${exempt.join(', ')})` : ''}`,
                status: over.length ? 'breach' : 'ok',
                detail: over.length
                    ? `${over.map(o => `${o.ticker} is ${o.p.toFixed(0)}%`).join(', ')} against a ${rule.value}% cap.`
                    : `Largest position is within ${rule.value}%.`
            };
        }

        if (rule.kind === 'min_cash' || rule.kind === 'max_cash') {
            const cashPct = pct(cash);
            const isMin = rule.kind === 'min_cash';
            const bad = isMin ? cashPct < rule.value : cashPct > rule.value;
            return {
                ...base,
                label: `${isMin ? 'At least' : 'At most'} ${rule.value}% cash`,
                status: bad ? 'breach' : 'ok',
                detail: `Cash is ${cashPct.toFixed(0)}% against a ${rule.value}% ${isMin ? 'floor' : 'ceiling'}.`
            };
        }

        if (rule.kind === 'avoid' || rule.kind === 'only') {
            const list = (rule.tickers || []).map(t => String(t).toUpperCase());
            if (!list.length) return null;
            const held = holdings.map(h => ({
                display: PortfolioApp.displayTicker(h.ticker),
                key: String((h.option && h.option.underlying) || h.ticker).toUpperCase()
            }));
            const offenders = rule.kind === 'avoid'
                ? held.filter(h => list.includes(h.key))
                : held.filter(h => !list.includes(h.key));
            return {
                ...base,
                label: rule.kind === 'avoid'
                    ? `Stay away from ${list.join(', ')}`
                    : `Only hold ${list.join(', ')}`,
                status: offenders.length ? 'breach' : 'ok',
                detail: offenders.length
                    ? `Holding ${[...new Set(offenders.map(o => o.display))].join(', ')}.`
                    : 'No holdings conflict with this.'
            };
        }

        // Prose the user stated that no formula covers ("nothing I would be
        // embarrassed to explain"). Surfaced, never silently scored.
        return {
            ...base,
            label: rule.text || 'Rule',
            status: 'judgment',
            detail: 'Stated in words. Check this against the holdings yourself.'
        };
    },

    /**
     * Would this trade push the portfolio off plan?
     *
     * Called when a transaction is saved (by hand or by the assistant) so the
     * conflict lands at the moment of the decision, not weeks later in a
     * drift table. Advisory only — it never blocks the trade. Returns null
     * when there is nothing worth saying.
     */
    checkTransaction(txn) {
        if (!txn || txn.type === 'sell') return null;
        const { strategy } = this.forAccount(txn.accountId);
        if (!strategy || strategy.status === 'draft') return null;

        // The transaction is already saved, so this is the post-trade picture
        // — which is what the user needs told. Everything below is filtered to
        // THIS trade: an advisory that also recites unrelated pre-existing
        // breaches is an audit, and it trains the user to ignore the warning.
        const report = this.evaluate(strategy);
        if (!report || report.empty) return null;

        const ticker = String(txn.ticker).toUpperCase();
        const underlying = (PortfolioApp.optionMeta(ticker) || {}).underlying || ticker;
        const isTraded = (sym) => {
            const u = String(sym || '').toUpperCase();
            return u === ticker || u === underlying;
        };
        const display = PortfolioApp.displayTicker(txn.ticker);
        const notes = [];

        // The traded name's own weight, options rolled up with their stock.
        const holdings = PortfolioApp.computeHoldings() || [];
        const tradedValue = holdings
            .filter(h => isTraded(h.ticker) || (h.option && isTraded(h.option.underlying)))
            .reduce((sum, h) => sum + (h.currentValue || 0), 0);
        const tradedPct = report.total > 0 ? (tradedValue / report.total) * 100 : 0;
        const cashPct = report.total > 0 ? (report.cash / report.total) * 100 : 0;

        for (const rule of (strategy.rules || [])) {
            const exempt = (rule.exclude || []).some(isTraded);
            if (rule.kind === 'max_position' && !exempt && tradedPct > rule.value) {
                notes.push(`${display} is now ${tradedPct.toFixed(0)}% of the portfolio, over your ${rule.value}% cap.`);
            } else if (rule.kind === 'avoid' && (rule.tickers || []).some(isTraded)) {
                notes.push(`${display} is on your stay-away list.`);
            } else if (rule.kind === 'only' && !(rule.tickers || []).some(isTraded)) {
                notes.push(`${strategy.name} says only ${(rule.tickers || []).join(', ')}.`);
            } else if (rule.kind === 'min_cash' && txn.type !== 'holding' && cashPct < rule.value) {
                // A buy is what spent the cash, so this one is on the trade.
                notes.push(`Cash is down to ${cashPct.toFixed(0)}%, under your ${rule.value}% floor.`);
            }
        }

        // report.targets is index-aligned with strategy.targets, so match on
        // the plan's own tickers rather than the report's display copies.
        (strategy.targets || []).forEach((target, i) => {
            const scored = report.targets[i];
            if (!scored || scored.status !== 'over') return;
            if (!(target.tickers || []).some(isTraded)) return;
            notes.push(`${scored.label} is now ${scored.actualPct.toFixed(0)}%, over its ${scored.maxPct}% band.`);
        });

        const planned = (strategy.targets || []).some(t => (t.tickers || []).some(isTraded));
        if ((strategy.targets || []).length && !planned) {
            notes.push(`${display} is not part of any sleeve in ${strategy.name}.`);
        }

        if (!notes.length) return null;
        return { strategyName: strategy.name, notes: notes.slice(0, 3) };
    },

    // ── Normalizers (assistant-supplied data is never trusted raw) ────────

    _normalizeTargets(targets) {
        if (!Array.isArray(targets)) return [];
        return targets.map(t => {
            const targetPct = this._num(t.targetPct);
            const out = {
                id: t.id || crypto.randomUUID(),
                label: String(t.label || 'Unnamed').slice(0, 60),
                tickers: this._tickerList(t.tickers),
                includeCash: !!t.includeCash,
                targetPct
            };
            if (t.minPct != null) out.minPct = this._num(t.minPct);
            if (t.maxPct != null) out.maxPct = this._num(t.maxPct);
            return out;
        }).filter(t => t.targetPct != null);
    },

    _normalizeRules(rules) {
        if (!Array.isArray(rules)) return [];
        return rules.map(r => {
            const kind = this.RULE_KINDS[r.kind] ? r.kind : 'custom';
            const out = { id: r.id || crypto.randomUUID(), kind, text: String(r.text || '').slice(0, 300) };
            if (kind === 'max_position' || kind === 'min_cash' || kind === 'max_cash') {
                out.value = this._num(r.value);
                if (out.value == null) return null;
            }
            if (kind === 'max_position' && r.exclude) out.exclude = this._tickerList(r.exclude);
            if (kind === 'avoid' || kind === 'only') {
                out.tickers = this._tickerList(r.tickers);
                if (!out.tickers.length) return null;
            }
            if (kind === 'custom' && !out.text) return null;
            return out;
        }).filter(Boolean);
    },

    _tickerList(list) {
        if (!Array.isArray(list)) return [];
        return list
            .map(t => String(t || '').trim().toUpperCase())
            .filter(Boolean)
            .slice(0, 40);
    },

    _num(v) {
        const n = typeof v === 'number' ? v : parseFloat(v);
        return Number.isFinite(n) ? n : null;
    }
};
