/**
 * PlanUsage — what the person sees about their nenva cloud plan (billing,
 * docs/BILLING.md; groundwork for phase P2, built 2026-10-07).
 *
 * Pure functions over Connect's `/v1/usage` answer, shared by main (the
 * line a refused cloud call shows) and the renderer (Settings › Plan and
 * the 80% notice), so the words are written once:
 *
 *  - view(usage, opts)      the Plan page's facts: plan name, AI used as a
 *                           percentage (chat and background apart),
 *                           searches as a count, when it resets.
 *  - quotaMessage(info)     the 100% line, written by code, never a model
 *                           (law B4: stop, never switch, never surprise).
 *  - noticeDue(usage, seen) which 80% / 100% notice is owed this month, if
 *                           any, given what was already shown.
 *
 * Laws from BILLING.md this file holds: people see percentages and counts,
 * never tokens or cost (B2); nothing here offers a price or a purchase
 * (no prices are published until checkout exists).
 */
const PlanUsage = {
    NOTICE_AT: 80,

    /** "Plus" from "plus"; unknown or empty is "Free". */
    planName(tier) {
        const t = String(tier || 'free').trim().toLowerCase();
        return { free: 'Free', plus: 'Plus', pro: 'Pro' }[t] || (t.charAt(0).toUpperCase() + t.slice(1));
    },

    /** "November 1" from Connect's "2026-11-01" (a UTC date: read it as one). */
    resetLabel(resetsAt) {
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(resetsAt || ''));
        if (!m) return '';
        const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
        return `${months[parseInt(m[2], 10) - 1]} ${parseInt(m[3], 10)}`;
    },

    _pct(used, quota) {
        return quota > 0 ? Math.min(100, Math.floor((Number(used) || 0) / quota * 100)) : 0;
    },

    /**
     * The Plan page's facts. `usage` is /v1/usage as main's IPC returns it
     * (or {error} / {notProvisioned}). An older Connect has no `ai` /
     * `searches`, so they are derived from the old fields the same way the
     * server does. `opts.local`: the default model runs on this Mac.
     */
    view(usage, opts = {}) {
        const u = usage || {};
        if (u.error) return { state: 'error', error: String(u.error) };
        if (u.notProvisioned) return { state: 'unused', local: !!opts.local };
        const llm = u.llm || {};
        const ai = u.ai && Number.isFinite(u.ai.percent) ? {
            percent: u.ai.percent,
            chatPercent: Number.isFinite(u.ai.chatPercent) ? u.ai.chatPercent : u.ai.percent,
            backgroundPercent: Number.isFinite(u.ai.backgroundPercent) ? u.ai.backgroundPercent : 0
        } : (() => {
            const p = Math.max(this._pct(llm.requests, llm.requestQuota), this._pct(llm.tokens, llm.tokenQuota));
            return { percent: p, chatPercent: p, backgroundPercent: 0 };
        })();
        const searches = u.searches && Number.isFinite(u.searches.allowance)
            ? { used: Number(u.searches.used) || 0, allowance: u.searches.allowance }
            : { used: Number(u.used) || 0, allowance: Number(u.quota) || 0 };
        return {
            state: 'ok',
            plan: this.planName(u.plan || u.tier),
            resets: this.resetLabel(u.resetsAt),
            ai,
            aiLevel: ai.percent >= 100 ? 'out' : ai.percent >= this.NOTICE_AT ? 'high' : 'ok',
            searches,
            searchLevel: searches.allowance && searches.used >= searches.allowance ? 'out'
                : searches.allowance && searches.used / searches.allowance * 100 >= this.NOTICE_AT ? 'high' : 'ok',
            local: !!opts.local,
            // Billing P3: whether plans can be bought here, whether this Mac's
            // plan is a purchase ('code'), its standing and renewal, and what
            // is on sale (the server's own list; prices are on Stripe's page).
            billing: this._billing(u.billing)
        };
    },

    _billing(b) {
        const x = b && typeof b === 'object' ? b : {};
        const plans = (Array.isArray(x.plans) ? x.plans : [])
            .filter(p => p && /^[a-z]+$/.test(String(p.id || '')) && Array.isArray(p.intervals))
            .map(p => ({ id: p.id, name: this.planName(p.id), intervals: p.intervals.filter(i => i === 'month' || i === 'year'),
                searches: Number(p.searches) || 0 }));
        const packs = (Array.isArray(x.packs) ? x.packs : [])
            .filter(p => p && /^[a-z0-9-]{1,40}$/.test(String(p.id || '')))
            .map(p => ({ id: p.id, searches: Math.max(0, Number(p.searches) || 0), cloud: !!p.cloud }));
        const top = x.topup && typeof x.topup === 'object' ? x.topup : {};
        return {
            available: !!x.available && plans.length > 0,
            paid: x.source === 'code',
            status: x.status || null,
            lapsed: x.source !== 'code' && (x.status === 'canceled' || x.status === 'past_due' || x.status === 'refunded'),
            renews: this.resetLabel(x.renews),
            manage: !!x.manage,
            trialEnds: x.trial && x.trial.endsAt ? this.resetLabel(x.trial.endsAt) : '',
            topup: { searches: Math.max(0, Number(top.searches) || 0), cloud: !!top.cloud },
            packs,
            plans
        };
    },

    /**
     * The line a refused nenva cloud call shows (Connect's 429 code 'quota').
     * Says what happened, when it ends and what the person can do now. It
     * never switches models for them and offers nothing to buy.
     */
    quotaMessage({ resetsAt, plan, kind = 'ai' } = {}) {
        const when = this.resetLabel(resetsAt);
        const reset = when ? ` It resets on ${when}.` : ' It resets at the start of next month.';
        // An older Connect does not say which plan; then the line names none.
        const on = plan ? ` on the ${this.planName(plan)} plan` : '';
        if (kind === 'background') {
            return `This month's share for background work (reading your email, routines) is used${on}.${reset} Chat still works.`;
        }
        if (kind === 'search') {
            return `You've used this month's web searches${on}.${reset} You can add your own search key in Settings › Advanced › Web search, and see your usage in Settings › Plan.`;
        }
        return `You've used this month's nenva cloud allowance${on}.${reset} Until then you can choose nenva local in Settings › Model, and see your usage in Settings › Plan.`;
    },

    /**
     * Which notice is owed: { key, title, body } or null. `seen` is the set
     * of keys already shown (per Mac). One notice per level, per kind, per
     * month: "ai:80:2026-11", "search:100:2026-11".
     */
    noticeDue(usage, seen = new Set()) {
        const v = this.view(usage);
        if (v.state !== 'ok') return null;
        const period = String((usage && usage.period) || '');
        const reset = v.resets ? ` It resets on ${v.resets}.` : '';
        const owed = [];
        if (v.aiLevel === 'out') owed.push({ key: `ai:100:${period}`, title: 'nenva cloud allowance used',
            body: `You've used this month's nenva cloud allowance.${reset} nenva local still works.` });
        else if (v.aiLevel === 'high') owed.push({ key: `ai:80:${period}`, title: `${v.ai.percent}% of nenva cloud used`,
            body: `You've used ${v.ai.percent}% of this month's nenva cloud allowance.${reset}` });
        if (v.searchLevel === 'out') owed.push({ key: `search:100:${period}`, title: 'Web searches used',
            body: `You've used this month's ${v.searches.allowance.toLocaleString('en-US')} web searches.${reset}` });
        else if (v.searchLevel === 'high') owed.push({ key: `search:80:${period}`, title: 'Web searches running low',
            body: `${v.searches.used.toLocaleString('en-US')} of ${v.searches.allowance.toLocaleString('en-US')} web searches used this month.${reset}` });
        return owed.find(n => !seen.has(n.key)) || null;
    },

    /* ── Renderer: the hourly look (started from AppManager.init) ──────
       Reads usage without ever minting a key (provision=false: a Mac that
       has not used nenva cloud or search has nothing to report), and posts
       at most one owed notice per look through Notify, the one funnel. A
       click opens Settings › Plan. What was shown is per Mac, in
       localStorage; the keys carry the month, so a new month starts clean. */
    SEEN_KEY: 'plan-notices-seen',
    LOOK_EVERY_MS: 60 * 60 * 1000,
    _last: null,

    _seen() {
        try { return new Set(JSON.parse(localStorage.getItem(this.SEEN_KEY) || '[]')); } catch { return new Set(); }
    },
    _remember(key) {
        try {
            const keep = [...this._seen()].slice(-20);
            keep.push(key);
            localStorage.setItem(this.SEEN_KEY, JSON.stringify(keep));
        } catch { /* private window */ }
    },

    /** The latest usage (for the Plan page), fetched fresh when older than `maxAgeMs`. */
    async fetch({ maxAgeMs = 60 * 1000 } = {}) {
        if (this._last && Date.now() - this._last.at < maxAgeMs) return this._last.usage;
        if (typeof window === 'undefined' || !window.electronSearch || !window.electronSearch.connectUsage) return { error: 'unavailable' };
        let usage;
        try { usage = await window.electronSearch.connectUsage(false); } catch (e) { usage = { error: e && e.message || 'unavailable' }; }
        if (usage && !usage.error) this._last = { at: Date.now(), usage };
        return usage || { error: 'unavailable' };
    },

    async look() {
        const usage = await this.fetch({ maxAgeMs: 0 });
        const due = this.noticeDue(usage, this._seen());
        if (!due || typeof Notify === 'undefined') return null;
        this._remember(due.key);
        Notify.show(due.title, due.body, {
            onClick: () => { if (typeof SimpleSettings !== 'undefined') SimpleSettings.open('plan'); }
        });
        return due;
    },

    init() {
        if (this._timer || typeof window === 'undefined') return;
        setTimeout(() => this.look().catch(() => {}), 90 * 1000);
        this._timer = setInterval(() => this.look().catch(() => {}), this.LOOK_EVERY_MS);
    }
};

if (typeof module !== 'undefined' && module.exports) module.exports = PlanUsage;
