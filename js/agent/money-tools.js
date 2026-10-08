/**
 * Money tools — the assistant reads the person's whole money picture in one
 * call (docs/MONEY_COACH.md, 2026-10-03): js/core/money-facts.js joins
 * Portfolio, Spending and the bills and subscriptions kept from mail.
 *
 * Group `money`, loaded with use_tools: money_overview (read),
 * save_money_goal / remove_money_goal (ask) and the `money` specialist for
 * jobs. Blocked in untrusted turns (bill
 * titles carry what senders wrote). No single
 * dataClass: the sheet is built from three classes, and MoneyFacts.gather
 * leaves out each part an ambient run's model may not see.
 */
(() => {
    if (typeof AgentTools === 'undefined' || typeof AgentTools.register !== 'function') return;

    AgentTools.GROUP_INFO.money = 'the whole money picture in one read: net worth and its change, cash, income and spending by month, savings rate, recurring charges, debts, bills from mail, and how the investments sit against the plan';

    AgentTools.register({ type: 'function', function: {
        name: 'money_overview',
        description: 'The user\'s whole money picture, computed by the app from everything it holds: net worth and how it changed, investment accounts and largest holdings, the investment plan and where holdings sit off it, cash in the bank and how many months of spending it covers, this month and recent months (spent, income, kept, savings rate), charges that come back every month, debts with their rates, and open bills and subscriptions found in mail and texts. For building or revising their plan (goals, debts, what to do next) call plan_money instead. Call this FIRST for any question about their finances as a whole ("how am I doing with money", "where can I save", "can I afford X", "what should I do with my cash"). `notKnown` lists what the app cannot see; say so instead of guessing, and offer the way to add it. Use these numbers, never your own. When advising: speak to their plan, cash, debt, costs and habits; you may suggest a specific stock or fund when it fits their plan, giving reasons from facts you read (get_ticker_profile, check_strategy), but never predict a price, call the market or promise a return.',
        parameters: { type: 'object', properties: {} }
    }}, (_args = {}, ctx) => {
        if (typeof MoneyFacts === 'undefined') return { error: 'Not available in this build.' };
        return MoneyFacts.current(ctx);
    }, { group: 'money', blockUntrusted: true, readOnly: true });

    const esc = (v) => (typeof UIUtils !== 'undefined' ? UIUtils.escapeHtml(String(v == null ? '' : v)) : String(v == null ? '' : v));
    const usd = (n) => `$${Math.round(Number(n) || 0).toLocaleString('en-US')}`;

    // A money goal IS a commitment (docs/COMMITMENTS.md: one store for what
    // the person said they would do); MoneyPlan keeps only the amount and
    // where the money sits. Progress is the sheet's arithmetic.
    AgentTools.register({ type: 'function', function: {
        name: 'save_money_goal',
        description: 'Save or change a goal with an amount: an emergency fund, a down payment, a trip, paying something off by a date. Only what the user said or agreed to. The goal becomes a commitment (pass commitment_id to attach the amount to one that exists; otherwise one is created with this title and date). `accounts` are the accounts whose balance counts toward it, by name as money_overview lists them; without any, pass saved_so_far if they told you a figure. Progress then shows in money_overview (saved, percent, months left, needed a month).',
        parameters: { type: 'object', properties: {
            title: { type: 'string', description: 'The goal in their words, e.g. "Emergency fund"' },
            amount: { type: 'number', description: 'The target, in dollars' },
            by: { type: 'string', description: 'YYYY-MM-DD, when they want it by (optional)' },
            accounts: { type: 'array', items: { type: 'string' }, description: 'Accounts that hold this money' },
            saved_so_far: { type: 'number', description: 'Only when no account holds it and they told you the figure' },
            commitment_id: { type: 'string', description: 'An existing commitment this amount belongs to' }
        }, required: ['title', 'amount'] }
    }}, (a = {}) => {
        if (typeof MoneyPlan === 'undefined') return { error: 'Not available in this build.' };
        const C = typeof Commitments !== 'undefined' && Commitments._inited ? Commitments : null;
        const title = String(a.title || '').replace(/\s+/g, ' ').trim();
        if (!title) return { error: 'A goal needs a title.' };
        if (!(Number(a.amount) > 0)) return { error: 'A goal needs an amount above zero.' };
        const by = /^\d{4}-\d{2}-\d{2}$/.test(String(a.by || '')) ? a.by : null;
        let id = a.commitment_id ? String(a.commitment_id) : null;
        if (id && C && !C.get(id)) return { error: 'No commitment with that id. Call list_commitments for ids, or leave it out to create one.' };
        if (!id && C) {
            const same = C.all().find(c => c.state === 'open' && c.title.toLowerCase() === title.toLowerCase());
            if (same) id = same.id;
            else {
                const r = C.create({ title, ...(by ? { by } : {}), outcome: `${usd(a.amount)} set aside` }, { by: 'assistant', why: 'money goal' });
                if (!r.ok) return { error: r.error };
                id = r.id;
            }
        } else if (id && C && by) C.change(id, { by }, { by: 'assistant', why: 'money goal' });
        if (!id) id = `goal-${Date.now().toString(36)}`;
        const g = MoneyPlan.save({ id, amount: a.amount, title, by, ...(a.accounts ? { accounts: a.accounts } : {}), ...(a.saved_so_far != null ? { saved: a.saved_so_far } : {}) });
        if (g.error) return { error: g.error };
        const sheet = typeof MoneyFacts !== 'undefined' ? MoneyFacts.current() : null;
        const now = sheet && (sheet.goals || []).find(x => x.id === id);
        return { success: true, id, goal: now || { id, title, target: g.amount }, ...(now && now.accountsNotFound ? { note: `No account named ${now.accountsNotFound.join(', ')}; check money_overview for the names.` } : {}) };
    }, { group: 'money', ask: true, blockUntrusted: true,
        describe: (a) => `Save the goal <strong>${esc(a.title)}</strong>: ${esc(usd(a.amount))}${a.by ? ` by ${esc(a.by)}` : ''}${(a.accounts || []).length ? `, counted from ${esc(a.accounts.join(', '))}` : ''}` });

    // The household plan is a conversation (docs/MONEY_COACH.md): the app
    // says what it knows and what is missing; the assistant asks only that.
    AgentTools.register({ type: 'function', function: {
        name: 'plan_money',
        description: 'Start or continue the user\'s household money plan as a conversation. Returns what the app already knows (the money overview), what a sound plan still lacks, and how to run the conversation. Call it when they want a financial plan, ask "what should I be doing with my money", or want to set money goals. Ask only what is missing, one thing at a time.',
        parameters: { type: 'object', properties: {} }
    }}, (_a = {}, ctx) => {
        if (typeof MoneyFacts === 'undefined') return { error: 'Not available in this build.' };
        const sheet = MoneyFacts.current(ctx);
        const said = (() => { try { return typeof MemoryManager !== 'undefined' ? MemoryManager.all().filter(f => ['preferences', 'plans', 'about'].includes(f.heading)).map(f => f.text).slice(0, 40) : []; } catch { return []; } })();
        const missing = [];
        if (!sheet.goals) missing.push('goals: no goal with an amount is saved. The usual first one is an emergency fund (how many months of spending they want set aside, and where it sits); then what they are saving toward and by when.');
        if (!sheet.has.bank && !(sheet.fromMail && sheet.fromMail.paidToThemByMonth)) missing.push('income and spending: not known to the app. Ask roughly what comes in and what goes out a month' + ((typeof Anjadhe !== 'undefined' && Anjadhe.use('spending')) ? ', or point them to linking a bank in Spending.' : '.'));
        if (sheet.debts && sheet.debts.some(d => d.ratePct == null)) missing.push(`debt rates: no interest rate recorded for ${sheet.debts.filter(d => d.ratePct == null).map(d => d.name).join(', ')}.`);
        if (!sheet.debts) missing.push('debts: none recorded. Ask whether they owe anything (a mortgage, a car or student loan, a card balance) and record it with save_liability.');
        if (sheet.has.investments && !sheet.plan) missing.push('investment plan: they hold investments with no saved plan. start_strategy_interview builds one.');
        if (!sheet.has.investments) missing.push('investments: no accounts recorded. Ask whether they invest (a 401(k), an IRA, a brokerage) before assuming they do not.');
        return {
            overview: sheet,
            theyHaveToldYou: said,
            missing,
            instructions: 'Run this as a conversation, not a form. Start with one sentence on where they stand, from the overview\'s own numbers. Then take the missing items ONE at a time, most important first; skip anything their own words above already answer. For each: ask, say in a sentence why it matters, and offer two or three concrete options to react to (propose amounts from their numbers; do not ask for a figure cold). Save as you go: a goal with save_money_goal, a debt with save_liability, an investment plan through start_strategy_interview. How much they want to keep each month and which debt to clear first are their preferences: nenva remembers those from their own words, so repeat the sentence back plainly and do not call a tool for it. Never save a number they did not agree to. When nothing is missing, call money_overview and show them the plan in a few lines: goals and pace, debts in the order they chose, and the one thing to do this month. You may suggest a specific fund or stock when the facts support it; never predict a price, call the market or promise a return.'
        };
    }, { group: 'money', blockUntrusted: true, readOnly: true });

    AgentTools.register({ type: 'function', function: {
        name: 'remove_money_goal',
        description: 'Take the amount off a goal (id from money_overview). The commitment itself stays; change or drop that with the commitment tools.',
        parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }
    }}, (a = {}) => {
        if (typeof MoneyPlan === 'undefined') return { error: 'Not available in this build.' };
        return MoneyPlan.remove(String(a.id || '')) ? { success: true } : { error: 'No money goal with that id.' };
    }, { group: 'money', ask: true, blockUntrusted: true,
        describe: (a) => `Remove the amount from the goal <strong>${esc((MoneyPlan.get(String(a.id || '')) || {}).title || a.id)}</strong>` });

    // The money specialist (js/agent/specialists/registry.js): any job, in a
    // chat or a routine, can bring it in to read the whole picture. Private
    // data only, so the read-OR-web law holds; market research goes to
    // Research, with no private detail in the query.
    const specialist = () => {
        if (typeof Specialists === 'undefined') return;
        Specialists.register({ id: 'money', label: 'Money', needs: { apps: ['portfolio', 'spending'] }, steps: 12, budgetMs: 3 * 60000,
            tools: ['money_overview', 'list_portfolio', 'get_ticker_detail', 'get_strategy', 'check_strategy', 'spending_summary', 'list_spending', 'list_matters', 'get_matter', 'list_commitments', 'get_commitment'],
            writes: ['create_schedule_item'],
            when: 'reads the user\'s whole money picture: net worth, accounts and holdings, the investment plan and how far holdings sit from it, bank and card spending, recurring charges, debts, bills found in mail, money goals. Use it for any question or job about their finances.',
            prompt: 'Start with money_overview: it is computed by the app and says what it cannot see. Look closer only where the job needs it (the purchases behind a category, one holding, the plan report, a bill\'s messages). Use numbers exactly as the tools give them and say which tool each came from; never estimate or round. Say what could not be seen rather than guessing. You may suggest a specific step, a fund or stock included, with the reason from what you read; never predict a price, call the market or promise a return.' });
    };
    if (typeof Specialists !== 'undefined') specialist(); else window.addEventListener('DOMContentLoaded', specialist);
})();
