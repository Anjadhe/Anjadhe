/**
 * InstitutionLink — the one Plaid Hosted Link flow, shared by every app that
 * links a financial institution through Anjadhe Connect (Portfolio for
 * brokerages, Spending for banks and cards; docs/PORTFOLIO.md "Brokerage
 * linking", docs/SPENDING.md).
 *
 * What it owns: starting a link (main.js opens Plaid Hosted Link in the
 * default browser), polling Connect until the user finishes there, and the
 * code → sentence table for Connect's error codes. What it does NOT own:
 * anything about accounts or data — the app that asked decides what to do
 * with the linked item.
 *
 * `products` is the cost line: Connect asks Plaid for exactly this list, so
 * a brokerage link (['investments']) never bills Transactions and a bank
 * link (['transactions', 'investments']) gets both. The first entry is the
 * required product; the rest are optional at the institution.
 */
const InstitutionLink = {
    POLL_MS: 3000,
    POLL_MAX_MS: 30 * 60 * 1000,        // Hosted Link URLs live 30 minutes
    PRODUCTS: { brokerage: ['investments'], bank: ['transactions', 'investments'] },

    _linking: false,

    /** Behind the `brokerage` feature flag (js/core/features.js) — every door reads this. */
    available() {
        if (typeof window === 'undefined' || !window.electronBrokerage) return false;
        return typeof FEATURES === 'undefined' || FEATURES.isEnabled('brokerage');
    },

    busy() { return this._linking; },

    _toast(msg, kind = 'info') {
        if (typeof UIUtils !== 'undefined') UIUtils.showToast(msg, kind);
    },

    /** Connect's error code → a sentence for the user. */
    failMessage(r, fallback) {
        const code = r?.code;
        if (code === 'disabled') return 'Account linking is not enabled on Anjadhe Connect yet.';
        if (code === 'capacity') return 'Anjadhe Connect is at its account-linking capacity right now. Try again later.';
        if (code === 'cap') return r.error || 'Your plan’s account link limit is reached.';
        if (code === 'login_required') return 'This institution needs you to sign in again.';
        if (code === 'PRODUCT_NOT_READY') return 'The institution has not prepared your data yet — try again in a minute.';
        if (code === 'connect') return 'Anjadhe Connect could not be reached right now.';
        return r?.error || fallback;
    },

    /**
     * Link a new institution (or, with `itemId`, re-authorise an existing
     * one in Plaid's update mode). Resolves to Connect's finished status
     * ({status:'done', item:{itemId, institution, products}}) or null when
     * the user cancelled, the link expired, or Connect said no — every
     * failure has already been toasted.
     */
    async start({ itemId = null, products = null, what = 'your institution' } = {}) {
        if (!this.available() || this._linking) return null;
        this._linking = true;
        try {
            const start = await window.electronBrokerage.linkStart(itemId, itemId ? undefined : products);
            if (start.error) { this._toast(this.failMessage(start, 'Could not start linking'), 'error'); return null; }
            if (!itemId) this._toast(`Sign in to ${what} in the browser window that just opened`, 'info');
            return await this._waitForLink(start.linkToken);
        } finally {
            this._linking = false;
        }
    },

    async _waitForLink(linkToken) {
        const t0 = Date.now();
        let failures = 0;
        while (Date.now() - t0 < this.POLL_MAX_MS) {
            await new Promise(r => setTimeout(r, this.POLL_MS));
            const st = await window.electronBrokerage.linkStatus(linkToken);
            if (st.error) {
                // A slow sign-in is not a failure: rate limits and a blip
                // reaching Connect or Plaid just mean "ask again". Only a
                // definite answer, or a long run of them, ends the wait.
                const transient = st.code === 'rate' || st.code === 'connect' || st.code === 'upstream';
                if (transient && ++failures < 12) continue;
                this._toast(this.failMessage(st, 'Linking failed'), 'error');
                return null;
            }
            failures = 0;
            if (st.status === 'done') return st;
            if (st.status === 'exited') { this._toast('Linking was cancelled', 'info'); return null; }
            if (st.status === 'expired' || st.status === 'unknown') { this._toast('The sign-in link expired — try again', 'error'); return null; }
        }
        this._toast('Gave up waiting for the sign-in — try again', 'error');
        return null;
    }
};

if (typeof module !== 'undefined' && module.exports) module.exports = InstitutionLink;
