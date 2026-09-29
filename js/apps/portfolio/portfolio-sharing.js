/**
 * PortfolioSharing — one account, read-only, on another Anjadhe user's Mac.
 * ========================================================================
 * docs/PORTFOLIO_SHARING.md is the law; this file is its phase 1. In brief:
 *
 *  - The OWNER's Portfolio account is the one source. This module builds a
 *    read-only PROJECTION of it (`buildProjection` — the ONE builder; what
 *    it has no field for cannot leave) and pushes it to a paired CONTACT
 *    over the peer channel (main.js peer channel, js/channel/peer-channel.mjs,
 *    end-to-end encrypted through the zero-knowledge relay). The consent
 *    dialog renders the builder's output; the same object is what is sent.
 *  - The RECIPIENT holds a leased copy: a `shared:<shareId>` account plus
 *    `shared:<shareId>:<txnId>` rows in its own portfolio blob (so its own
 *    Macs carry it), `readOnly`, excluded from its totals, replaced
 *    wholesale on every snapshot. `share.revoke` OR lease expiry deletes it
 *    (tombstoned) — deletion depends on no message arriving and on Connect
 *    remembering nothing.
 *  - THE FIRST SNAPSHOT IS THE OFFER. A snapshot for an unknown share is
 *    held (machine-local) until the recipient accepts it in Portfolio;
 *    declined shares are remembered and dropped silently.
 *  - Every (re)connect a contact announces itself (`peer.hello`); the owner
 *    answers with a fresh snapshot for each live share and a revoke for
 *    each revoked one, so lost frames heal on the next connection.
 *  - Inbound is UNTRUSTED: frames are shape-checked and value-clamped
 *    (`sanitizeProjection`), and nothing in them ever reaches the model as
 *    instructions — names are rendered, escaped, like every other name.
 *
 * Share records live in the synced portfolio blob's `shares[]` (record-
 * merged + tombstoned, main.js RECORD_MERGE_ARRAYS). Contacts are per-Mac
 * (they are bound to this Mac's static key), so ONE Mac pushes a share:
 * the one that holds the contact (`pushMachineId`, the `isHere` mould).
 *
 * Pure parts (buildProjection, projectionHash, sanitizeProjection,
 * materialize, leaseUntil, isExpired) are pinned by
 * tests/portfolio-sharing-test.js.
 */
const PortfolioSharing = {
    V: 1,
    SCOPES: ['read'],
    LEASE_DAYS: 30,
    HEARTBEAT_MS: 24 * 60 * 60 * 1000,
    PUSH_DEBOUNCE_MS: 3000,
    MAX_HOLDINGS: 2000,
    MAX_TXNS: 20000,
    // The whitelist. Notes (the owner's words), sourceRef (Plaid ids) and
    // anything else on a row stay home.
    TXN_FIELDS: ['date', 'type', 'ticker', 'quantity', 'pricePerShare', 'amount', 'subtype', 'fees'],
    TXN_TYPES: ['buy', 'sell', 'holding', 'cash'],
    ACCOUNT_TYPES: ['brokerage', '401k', 'ira', 'roth-ira', 'hsa', 'savings', 'checking', 'other'],
    OFFERS_KEY: 'portfolio-share-offers',
    DECLINED_KEY: 'portfolio-share-declined',

    // ── Pure: what crosses ─────────────────────────────────────────────

    /**
     * The ONE builder of an outbound payload. `holdings` are the owner's
     * computed positions (display + a future holdings-only scope); the
     * transactions are the rows the recipient's own arithmetic will
     * reproduce the positions from.
     */
    buildProjection({ account, transactions, holdings, scope = 'read', asOf } = {}) {
        if (!account) throw new Error('buildProjection: account required');
        const num = (v) => (typeof v === 'number' && Number.isFinite(v)) ? v : null;
        const str = (v, max) => (v == null ? '' : String(v)).slice(0, max);
        const rows = (Array.isArray(transactions) ? transactions : [])
            .filter(t => t && t.accountId === account.id && t.id)
            .map(t => {
                const out = { id: str(t.id, 80) };
                for (const f of this.TXN_FIELDS) {
                    if (t[f] === undefined || t[f] === null) continue;
                    out[f] = (f === 'date' || f === 'type' || f === 'ticker' || f === 'subtype') ? str(t[f], 40) : num(t[f]);
                    if (out[f] === null || out[f] === '') delete out[f];
                }
                return out;
            })
            .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')) || a.id.localeCompare(b.id))
            .slice(-this.MAX_TXNS);
        const pos = (Array.isArray(holdings) ? holdings : [])
            .filter(h => h && h.ticker && (h.totalShares || 0) > 0)
            .slice(0, this.MAX_HOLDINGS)
            .map(h => ({
                ticker: str(h.ticker, 40),
                totalShares: num(h.totalShares) ?? 0,
                avgCostBasis: num(h.avgCostBasis),
                currentPrice: num(h.currentPrice),
                currentValue: num(h.currentValue),
            }));
        return {
            v: this.V,
            scope: this.SCOPES.includes(scope) ? scope : 'read',
            asOf: asOf || new Date().toISOString(),
            account: {
                name: str(account.name, 120) || 'Account',
                type: this.ACCOUNT_TYPES.includes(account.type) ? account.type : 'other',
                cashBalance: num(account.cashBalance),
                institution: str(account.brokerage?.institution || account.institution || '', 80) || null,
            },
            holdings: pos,
            transactions: rows,
        };
    },

    /** Stable content hash — identical projections must not re-push. */
    projectionHash(p) {
        const { asOf, ...rest } = p || {};
        const s = JSON.stringify(rest);
        let h = 5381;
        for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
        return h.toString(16) + ':' + s.length;
    },

    /**
     * Inbound is untrusted. Returns a clean projection or null. Every string
     * is clamped, every number checked, every unknown field dropped — the
     * recipient's arithmetic and renderer only ever see this shape.
     */
    sanitizeProjection(p) {
        if (!p || typeof p !== 'object' || p.v !== this.V || !p.account || typeof p.account !== 'object') return null;
        const num = (v) => (typeof v === 'number' && Number.isFinite(v)) ? v : null;
        const str = (v, max) => (typeof v === 'string' ? v : '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max);
        const dateOk = (d) => /^\d{4}-\d{2}-\d{2}/.test(d);
        const account = {
            name: str(p.account.name, 120).trim() || 'Shared account',
            type: this.ACCOUNT_TYPES.includes(p.account.type) ? p.account.type : 'other',
            cashBalance: num(p.account.cashBalance),
            institution: str(p.account.institution || '', 80).trim() || null,
        };
        const holdings = (Array.isArray(p.holdings) ? p.holdings : []).slice(0, this.MAX_HOLDINGS)
            .map(h => h && typeof h === 'object' ? ({
                ticker: str(h.ticker, 40).trim(), totalShares: num(h.totalShares) ?? 0,
                avgCostBasis: num(h.avgCostBasis), currentPrice: num(h.currentPrice), currentValue: num(h.currentValue),
            }) : null)
            .filter(h => h && h.ticker && h.totalShares > 0);
        const seen = new Set();
        const transactions = (Array.isArray(p.transactions) ? p.transactions : []).slice(0, this.MAX_TXNS)
            .map(t => {
                if (!t || typeof t !== 'object') return null;
                const id = str(t.id, 80).trim();
                const type = this.TXN_TYPES.includes(t.type) ? t.type : null;
                const date = str(t.date, 40).trim();
                if (!id || !type || !dateOk(date) || seen.has(id)) return null;
                seen.add(id);
                const row = { id, type, date };
                const ticker = str(t.ticker, 40).trim();
                if (ticker) row.ticker = ticker;
                for (const f of ['quantity', 'pricePerShare', 'amount', 'fees']) { const v = num(t[f]); if (v !== null) row[f] = v; }
                const subtype = str(t.subtype, 40).trim();
                if (subtype) row.subtype = subtype;
                if (type !== 'cash' && (!row.ticker || row.quantity == null)) return null;
                return row;
            })
            .filter(Boolean);
        return { v: this.V, scope: this.SCOPES.includes(p.scope) ? p.scope : 'read', asOf: dateOk(str(p.asOf, 40)) ? p.asOf : new Date().toISOString(), account, holdings, transactions };
    },

    sharedAccountId: (shareId) => `shared:${shareId}`,
    sharedRowId: (shareId, txnId) => `shared:${shareId}:${txnId}`,
    leaseUntil(receivedAt) {
        return new Date(Date.parse(receivedAt) + this.LEASE_DAYS * 24 * 60 * 60 * 1000).toISOString();
    },
    isExpired(account, now = Date.now()) {
        const until = account?.shared?.leaseUntil;
        return !!until && Date.parse(until) < now;
    },

    /**
     * What a clean projection becomes on the recipient's disk. Pure: takes
     * the existing rows for this share (to compute removals) and returns
     * the account, the rows to keep, and the ids to tombstone. A row set
     * that is present reproduces the owner's positions through the
     * recipient's own computeHoldings; an empty one (a holdings-only
     * scope, later) seeds `holding` rows from the positions instead.
     */
    materialize({ shareId, contactId, contactLabel, generation, projection, receivedAt, existingRows = [], existingAccount = null }) {
        const accountId = this.sharedAccountId(shareId);
        const now = receivedAt || new Date().toISOString();
        const account = {
            id: accountId,
            name: projection.account.name,
            type: projection.account.type,
            cashBalance: projection.account.cashBalance,
            institution: projection.account.institution,
            source: 'shared',
            readOnly: true,
            createdAt: existingAccount?.createdAt || now,
            updatedAt: now,
            shared: {
                shareId, contactId, contactLabel: contactLabel || existingAccount?.shared?.contactLabel || 'a contact',
                generation, receivedAt: now, asOf: projection.asOf, leaseUntil: this.leaseUntil(now),
                scope: projection.scope,
            },
        };
        const src = projection.transactions.length ? projection.transactions
            : projection.holdings.map(h => ({
                id: `holding:${h.ticker}`, type: 'holding', ticker: h.ticker, quantity: h.totalShares,
                pricePerShare: h.avgCostBasis ?? h.currentPrice ?? 0, date: String(projection.asOf).slice(0, 10),
            }));
        const prior = new Map(existingRows.filter(r => r && r.accountId === accountId).map(r => [r.id, r]));
        const rows = src.map(t => {
            const id = this.sharedRowId(shareId, t.id);
            const old = prior.get(id);
            const row = { ...t, id, accountId, source: 'shared', createdAt: old?.createdAt || now, updatedAt: now };
            if (old) {
                const { createdAt, updatedAt, ...a } = old; const { createdAt: c2, updatedAt: u2, ...b } = row;
                if (JSON.stringify(a) === JSON.stringify(b)) return old; // unchanged rows keep their stamp
            }
            return row;
        });
        const keep = new Set(rows.map(r => r.id));
        const removedIds = [...prior.keys()].filter(id => !keep.has(id));
        return { account, rows, removedIds };
    },

    // ── Renderer state ─────────────────────────────────────────────────

    _machineId: null,
    _contacts: [],
    _pushTimer: null,
    _heartbeatTimer: null,
    _inited: false,
    _ready: false,

    /** Behind the `sharing` flag; every door reads this. */
    available() {
        return typeof FEATURES !== 'undefined' && FEATURES.isEnabled('sharing')
            && typeof window !== 'undefined' && !!window.electronPeers;
    },

    async init() {
        if (this._inited || !this.available()) return;
        this._inited = true;
        // Runs before Portfolio's own init (the package is lazy; this
        // module self-starts at load): make sure the blob is read.
        if (typeof PortfolioApp === 'undefined') { this._inited = false; return; }
        if (!Array.isArray(PortfolioApp.shares)) { try { PortfolioApp.loadData(); } catch { /* below */ } }
        try {
            const st = await window.electronSync?.getStatus?.();
            if (st && st.machineId) this._machineId = st.machineId;
        } catch { /* unknown machine: every share counts as here */ }
        window.electronPeers.onMessage(({ contactId, message }) => { try { this.handleMessage(contactId, message); } catch (e) { console.warn('[sharing] inbound failed', e); } });
        window.electronPeers.onChanged(() => this.refreshContacts().then(() => this.syncWithContacts()));
        await this.refreshContacts();
        this._ready = true;
        this.syncWithContacts();
        this.leaseSweep();
        // Announce ourselves to every contact: a sharer answers a hello with
        // a fresh snapshot of each live share, so anything pushed while this
        // window was not listening (a launch, a reload) lands now.
        this._helloAll();
        // Heartbeat: a snapshot at least daily keeps the far side's lease
        // renewed; the push itself is skipped when nothing changed and the
        // last one is recent.
        this._heartbeatTimer = setInterval(() => { this.leaseSweep(); this.pushDue(); }, 60 * 60 * 1000);
        setTimeout(() => this.pushDue(), 15 * 1000);
    },

    _helloAll() {
        if (!this.available()) return;
        for (const c of this._contacts) {
            window.electronPeers.send(c.id, { v: this.V, type: 'peer.hello' }).catch(() => {});
        }
    },

    async refreshContacts() {
        try {
            const info = await window.electronPeers.info();
            this._contacts = (info && info.contacts) || [];
            this._peersInfo = info || null;
        } catch { this._contacts = []; }
        return this._contacts;
    },
    contacts() { return this._contacts; },
    contact(id) { return this._contacts.find(c => c.id === id) || null; },
    contactLabel(id, fallback) {
        return this.contact(id)?.label || fallback || 'a contact';
    },

    // ── Owner side ─────────────────────────────────────────────────────

    shares() { return Array.isArray(PortfolioApp.shares) ? PortfolioApp.shares : []; },
    liveShares() { return this.shares().filter(s => s && !s.revokedAt); },
    sharesFor(accountId) { return this.liveShares().filter(s => s.accountId === accountId); },
    /** Pushed from THIS Mac (the one holding the contact) — the isHere mould. */
    isHere(share) {
        const m = share?.pushMachineId;
        return !m || !this._machineId || m === this._machineId;
    },

    /** The preview and the payload are one value: what share() will send. */
    projectionFor(accountId) {
        const account = PortfolioApp.accounts.find(a => a.id === accountId);
        if (!account) return null;
        return this.buildProjection({
            account,
            transactions: PortfolioApp.transactions,
            holdings: PortfolioApp.computeHoldings(accountId),
        });
    },

    /** Create the share record and push the first snapshot. */
    share(accountId, contactId) {
        const account = PortfolioApp.accounts.find(a => a.id === accountId);
        const contact = this.contact(contactId);
        if (!account || account.shared || !contact) return null;
        const dup = this.liveShares().find(s => s.accountId === accountId && s.contactId === contactId);
        if (dup) return dup;
        const now = new Date().toISOString();
        const share = {
            id: 'sh_' + Math.random().toString(36).slice(2, 12),
            accountId, contactId, contactLabel: contact.label, scope: 'read',
            createdAt: now, updatedAt: now, generation: 0,
            lastPushedAt: null, lastPushedHash: null, delivered: false,
            lastAckAt: null, lastAckGeneration: null, declinedAt: null,
            pushMachineId: this._machineId || null,
        };
        PortfolioApp.shares = [...this.shares(), share];
        PortfolioApp.saveData();
        this.pushShare(share.id, { force: true });
        return share;
    },

    /** Stop sharing: keep the record (revoked) until the recipient acks, so a
     *  recipient that was offline is told on its next hello; the lease covers
     *  a recipient that never returns. */
    revoke(shareId) {
        const share = this.shares().find(s => s.id === shareId);
        if (!share) return false;
        const now = new Date().toISOString();
        share.revokedAt = share.revokedAt || now;
        share.updatedAt = now;
        PortfolioApp.saveData();
        this._sendRevoke(share);
        return true;
    },

    _sendRevoke(share) {
        if (!this.available() || !this.isHere(share)) return Promise.resolve(false);
        return window.electronPeers.send(share.contactId, { v: this.V, type: 'share.revoke', shareId: share.id })
            .then(r => !!(r && r.delivered)).catch(() => false);
    },

    async pushShare(shareId, { force = false } = {}) {
        if (!this.available() || !this._ready) return false;
        const share = this.shares().find(s => s.id === shareId);
        if (!share || share.revokedAt || !this.isHere(share) || !this.contact(share.contactId)) return false;
        const projection = this.projectionFor(share.accountId);
        if (!projection) return false;
        const hash = this.projectionHash(projection);
        const fresh = share.lastPushedAt && (Date.now() - Date.parse(share.lastPushedAt)) < this.HEARTBEAT_MS;
        if (!force && share.delivered && hash === share.lastPushedHash && fresh) return false;
        const generation = (share.generation || 0) + 1;
        let delivered = false;
        try {
            const r = await window.electronPeers.send(share.contactId, { v: this.V, type: 'share.snapshot', shareId: share.id, generation, projection });
            delivered = !!(r && r.delivered);
        } catch { delivered = false; }
        // Re-read: saveData reloads, and the record object may be stale.
        const live = this.shares().find(s => s.id === shareId);
        if (!live) return delivered;
        live.generation = generation;
        live.lastPushedAt = new Date().toISOString();
        live.lastPushedHash = hash;
        live.delivered = delivered;
        live.updatedAt = live.lastPushedAt;
        this._quietSave();
        return delivered;
    },

    /** Every live share this Mac pushes whose content changed or lease-heartbeat is due. */
    pushDue() {
        for (const s of this.liveShares()) this.pushShare(s.id).catch(() => {});
    },

    /** saveData's hook: a change to a shared account travels within seconds. */
    onDataSaved() {
        if (!this.available() || !this._ready || this._saving) return;
        if (this._pushTimer) clearTimeout(this._pushTimer);
        this._pushTimer = setTimeout(() => { this._pushTimer = null; this.pushDue(); }, this.PUSH_DEBOUNCE_MS);
    },

    /** A save that must not re-trigger a push (ledger stamps only). */
    _quietSave() {
        this._saving = true;
        try { PortfolioApp.saveData(); } finally { this._saving = false; }
        this._renderIfVisible();
    },

    // ── Recipient side ─────────────────────────────────────────────────

    sharedAccounts() { return (PortfolioApp.accounts || []).filter(a => a && a.shared); },

    _offers() { try { return JSON.parse(localStorage.getItem(this.OFFERS_KEY) || '{}') || {}; } catch { return {}; } },
    _saveOffers(o) { try { localStorage.setItem(this.OFFERS_KEY, JSON.stringify(o)); } catch { /* cache only */ } },
    _declined() { try { return JSON.parse(localStorage.getItem(this.DECLINED_KEY) || '{}') || {}; } catch { return {}; } },
    _saveDeclined(d) { try { localStorage.setItem(this.DECLINED_KEY, JSON.stringify(d)); } catch { /* cache only */ } },
    /** Offers waiting for the user, newest first, with the contact's label. */
    pendingOffers() {
        const offers = this._offers();
        return Object.values(offers)
            .filter(o => o && o.shareId && this.contact(o.contactId))
            .map(o => ({ ...o, projection: this.sanitizeProjection(o.projection), contactLabel: this.contactLabel(o.contactId) }))
            .filter(o => o.projection)
            .sort((a, b) => String(b.receivedAt).localeCompare(String(a.receivedAt)));
    },

    handleMessage(contactId, message, retried = false) {
        if (!message || typeof message !== 'object') return;
        if (!this.contact(contactId)) {
            // A contact that paired a moment ago may not be in the cached
            // roster yet — refresh once before dropping the frame.
            if (retried) return;
            this.refreshContacts().then(() => this.handleMessage(contactId, message, true));
            return;
        }
        const type = String(message.type || '');
        if (type === 'peer.hello') return this._onHello(contactId);
        if (type === 'share.snapshot') return this._onSnapshot(contactId, message);
        if (type === 'share.revoke') return this._onRevoke(contactId, message);
        if (type === 'share.ack') return this._onAck(contactId, message);
    },

    _onHello(contactId) {
        for (const s of this.shares()) {
            if (s.contactId !== contactId || !this.isHere(s)) continue;
            if (s.revokedAt) this._sendRevoke(s);
            else this.pushShare(s.id, { force: true }).catch(() => {});
        }
    },

    _onSnapshot(contactId, message) {
        const shareId = typeof message.shareId === 'string' ? message.shareId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) : '';
        const generation = Number(message.generation);
        const projection = this.sanitizeProjection(message.projection);
        if (!shareId || !Number.isFinite(generation) || !projection) return;
        const existing = PortfolioApp.accounts.find(a => a.id === this.sharedAccountId(shareId));
        if (existing) {
            // Only the contact that shares it may update it.
            if (existing.shared.contactId !== contactId) return;
            if ((existing.shared.generation || 0) > generation) return;
            this._apply({ shareId, contactId, generation, projection });
            return;
        }
        if (this._declined()[shareId]) return;
        const offers = this._offers();
        offers[shareId] = { shareId, contactId, generation, projection, receivedAt: new Date().toISOString() };
        this._saveOffers(offers);
        this._renderIfVisible();
        this._toast(`${this.contactLabel(contactId)} wants to share “${projection.account.name}” with you — open Portfolio to accept`, 'info');
    },

    accept(shareId) {
        const offers = this._offers();
        const o = offers[shareId];
        if (!o) return false;
        delete offers[shareId];
        this._saveOffers(offers);
        const d = this._declined(); if (d[shareId]) { delete d[shareId]; this._saveDeclined(d); }
        this._apply({ shareId, contactId: o.contactId, generation: o.generation, projection: this.sanitizeProjection(o.projection) });
        return true;
    },

    decline(shareId) {
        const offers = this._offers();
        const o = offers[shareId];
        if (!o) return false;
        delete offers[shareId];
        this._saveOffers(offers);
        const d = this._declined(); d[shareId] = new Date().toISOString(); this._saveDeclined(d);
        this._ack(o.contactId, shareId, o.generation, { declined: true });
        this._renderIfVisible();
        return true;
    },

    _apply({ shareId, contactId, generation, projection }) {
        if (!projection) return;
        const accountId = this.sharedAccountId(shareId);
        const { account, rows, removedIds } = this.materialize({
            shareId, contactId, contactLabel: this.contactLabel(contactId), generation, projection,
            receivedAt: new Date().toISOString(),
            existingRows: PortfolioApp.transactions,
            existingAccount: PortfolioApp.accounts.find(a => a.id === accountId) || null,
        });
        for (const id of removedIds) PortfolioApp._tombstone(id);
        PortfolioApp.accounts = [...PortfolioApp.accounts.filter(a => a.id !== accountId), account];
        PortfolioApp.transactions = [...PortfolioApp.transactions.filter(t => t.accountId !== accountId), ...rows];
        this._quietSave();
        this._ack(contactId, shareId, generation);
        if (typeof PortfolioApp.autoRefreshPrices === 'function') { try { PortfolioApp.autoRefreshPrices(); } catch { /* quotes are a courtesy */ } }
    },

    _onRevoke(contactId, message) {
        const shareId = typeof message.shareId === 'string' ? message.shareId : '';
        if (!shareId) return;
        const offers = this._offers();
        if (offers[shareId] && offers[shareId].contactId === contactId) { delete offers[shareId]; this._saveOffers(offers); }
        const d = this._declined(); if (d[shareId]) { delete d[shareId]; this._saveDeclined(d); }
        const account = PortfolioApp.accounts.find(a => a.id === this.sharedAccountId(shareId));
        if (account && account.shared.contactId === contactId) {
            this.removeShared(shareId, { quiet: true });
            this._toast(`${this.contactLabel(contactId)} stopped sharing “${account.name}”`, 'info');
        }
        this._ack(contactId, shareId, 0, { revoked: true });
        this._renderIfVisible();
    },

    _ack(contactId, shareId, generation, extra = {}) {
        if (!this.available()) return;
        window.electronPeers.send(contactId, { v: this.V, type: 'share.ack', shareId, generation, ...extra }).catch(() => {});
    },

    _onAck(contactId, message) {
        const share = this.shares().find(s => s.id === message.shareId && s.contactId === contactId);
        if (!share) return;
        const now = new Date().toISOString();
        if (message.revoked) {
            // The recipient confirmed the delete: the record has done its job.
            PortfolioApp._tombstone(share.id);
            PortfolioApp.shares = this.shares().filter(s => s.id !== share.id);
            this._quietSave();
            return;
        }
        if (message.declined) share.declinedAt = now;
        else { share.lastAckAt = now; share.lastAckGeneration = Number(message.generation) || share.generation; share.delivered = true; share.declinedAt = null; }
        share.updatedAt = now;
        this._quietSave();
    },

    /** Delete a shared account and its rows (tombstoned so the recipient's other Macs drop them too). */
    removeShared(shareId, { quiet = false } = {}) {
        const accountId = this.sharedAccountId(shareId);
        const account = PortfolioApp.accounts.find(a => a.id === accountId);
        if (!account) return false;
        PortfolioApp._tombstone(accountId);
        PortfolioApp.transactions.filter(t => t.accountId === accountId).forEach(t => PortfolioApp._tombstone(t.id));
        PortfolioApp.accounts = PortfolioApp.accounts.filter(a => a.id !== accountId);
        PortfolioApp.transactions = PortfolioApp.transactions.filter(t => t.accountId !== accountId);
        if (typeof LinkManager !== 'undefined') { try { LinkManager.removeAllLinksForItem('portfolio', accountId); } catch { /* none */ } }
        this._quietSave();
        if (!quiet) this._toast('Shared account removed', 'success');
        return true;
    },

    /** Lease expiry is the second way a copy dies (law 6). */
    leaseSweep() {
        const now = Date.now();
        let n = 0;
        for (const a of this.sharedAccounts()) {
            if (!this.isExpired(a, now)) continue;
            this.removeShared(a.shared.shareId, { quiet: true });
            n++;
        }
        if (n) this._toast(`${n} shared account${n === 1 ? '' : 's'} expired — nothing arrived from the sharer for ${this.LEASE_DAYS} days`, 'info');
        // Revoked records nobody acked in a lease period are done too.
        const stale = this.shares().filter(s => s.revokedAt && now - Date.parse(s.revokedAt) > this.LEASE_DAYS * 24 * 60 * 60 * 1000);
        if (stale.length) {
            for (const s of stale) PortfolioApp._tombstone(s.id);
            PortfolioApp.shares = this.shares().filter(s => !stale.includes(s));
            this._quietSave();
        }
    },

    /** A contact that is gone takes its shares with it, both ways. */
    syncWithContacts() {
        if (!this._ready) return;
        const ids = new Set(this._contacts.map(c => c.id));
        let changed = false;
        for (const s of this.shares()) {
            if (!this.isHere(s) || ids.has(s.contactId)) continue;
            PortfolioApp._tombstone(s.id); changed = true;
        }
        if (changed) PortfolioApp.shares = this.shares().filter(s => !this.isHere(s) || ids.has(s.contactId));
        for (const a of this.sharedAccounts()) {
            if (ids.has(a.shared.contactId)) continue;
            this.removeShared(a.shared.shareId, { quiet: true }); changed = true;
        }
        const offers = this._offers();
        let o2 = false;
        for (const k of Object.keys(offers)) if (!ids.has(offers[k].contactId)) { delete offers[k]; o2 = true; }
        if (o2) this._saveOffers(offers);
        if (changed) this._quietSave();
        // Contact labels are local; keep the copies on records current.
        for (const a of this.sharedAccounts()) { const c = this.contact(a.shared.contactId); if (c && a.shared.contactLabel !== c.label) a.shared.contactLabel = c.label; }
        for (const s of this.shares()) { const c = this.contact(s.contactId); if (c && s.contactLabel !== c.label) s.contactLabel = c.label; }
    },

    // ── Presentation helpers ────────────────────────────────────────────

    /** The line under a shared account's name. */
    statusLine(account) {
        if (!account?.shared) return null;
        const sh = account.shared;
        const parts = [`Shared by ${sh.contactLabel || 'a contact'}`];
        if (sh.asOf) parts.push(`as of ${this.ago(sh.asOf)}`);
        const expired = this.isExpired(account);
        const daysLeft = sh.leaseUntil ? Math.ceil((Date.parse(sh.leaseUntil) - Date.now()) / 86400000) : null;
        let tone = 'ok';
        if (expired) { parts.push('expired'); tone = 'warn'; }
        else if (daysLeft != null && daysLeft <= 7) { parts.push(`nothing new for a while · removed in ${daysLeft} day${daysLeft === 1 ? '' : 's'} unless it updates`); tone = 'warn'; }
        return { text: parts.join(' · '), tone };
    },

    /** The line under an OWNER's account that is shared out. */
    sharedOutLine(accountId) {
        const list = this.sharesFor(accountId);
        if (!list.length) return null;
        const who = list.map(s => this.contactLabel(s.contactId, s.contactLabel)).join(', ');
        return { text: `Shared with ${who}`, tone: 'ok' };
    },

    ago(iso) {
        const t = Date.parse(iso); if (!t) return '';
        const s = Math.max(0, (Date.now() - t) / 1000);
        if (s < 90) return 'just now';
        if (s < 3600) return `${Math.round(s / 60)} min ago`;
        if (s < 86400 * 1.5) return `${Math.round(s / 3600)} h ago`;
        if (s < 86400 * 14) return `${Math.round(s / 86400)} days ago`;
        return new Date(t).toLocaleDateString();
    },

    _toast(msg, kind = 'info') { if (typeof UIUtils !== 'undefined') UIUtils.showToast(msg, kind); },
    _renderIfVisible() {
        if (typeof AppManager !== 'undefined' && AppManager.currentApp === 'portfolio' && typeof PortfolioApp.render === 'function') {
            try { PortfolioApp.render(); } catch { /* a render mid-edit is a courtesy */ }
        }
    },

    // ── Doors ───────────────────────────────────────────────────────────

    /** The consent dialog IS the preview: it renders exactly what will be sent. */
    async showShareModal(accountId) {
        if (!this.available()) return;
        await this.refreshContacts();
        const account = PortfolioApp.accounts.find(a => a.id === accountId);
        if (!account || account.shared) return;
        const esc = (s) => (typeof UIUtils !== 'undefined' ? UIUtils.escapeHtml(String(s ?? '')) : String(s ?? ''));
        const fmt = (n) => (typeof PortfolioUI !== 'undefined' ? PortfolioUI.formatMoney(n) : String(n));
        const already = new Set(this.sharesFor(accountId).map(s => s.contactId));
        const contacts = this._contacts.filter(c => !already.has(c.id));
        if (!this._contacts.length) {
            const go = await UIUtils.confirm('No contacts yet', 'Sharing goes to a contact — another Anjadhe user you have paired with by invite code. Add one in Settings › Accounts › Contacts first.', '', { confirmText: 'Open Settings' });
            if (go && typeof AppManager !== 'undefined') AppManager.openAppSettings?.('portfolio-sharing');
            return;
        }
        if (!contacts.length) { this._toast('This account is already shared with every contact', 'info'); return; }
        const p = this.projectionFor(accountId);
        const first = p.transactions[0]?.date, last = p.transactions[p.transactions.length - 1]?.date;
        const holdingsHtml = p.holdings.slice(0, 12).map(h => `<li><b>${esc(h.ticker)}</b> · ${esc(h.totalShares)} shares${h.currentValue != null ? ` · ${esc(fmt(h.currentValue))}` : ''}</li>`).join('')
            + (p.holdings.length > 12 ? `<li>and ${p.holdings.length - 12} more</li>` : '');
        const options = contacts.map(c => `<option value="${esc(c.id)}">${esc(c.label)}${c.online ? '' : ' (offline)'}</option>`).join('');
        const modal = Modal.create({
            title: `Share “${esc(account.name)}”`,
            className: 'portfolio-link-modal portfolio-share-modal',
            content: `
                <p class="portfolio-link-lede">Read-only. They see this account in their Portfolio app as it is now and each time it changes, encrypted end to end between your Macs. You can stop sharing any time and it is removed from their app.</p>
                <label class="portfolio-share-field"><span>Share with</span><select id="portfolio-share-contact" class="settings-inline-select">${options}</select></label>
                <div class="portfolio-share-preview">
                    <div class="portfolio-share-preview-head">What they will see</div>
                    <div class="portfolio-share-row"><span>Account</span><span>${esc(p.account.name)} · ${esc(typeof PortfolioUI !== 'undefined' ? PortfolioUI.formatAccountType(p.account.type) : p.account.type)}${p.account.institution ? ` · ${esc(p.account.institution)}` : ''}</span></div>
                    <div class="portfolio-share-row"><span>Positions</span><span>${p.holdings.length ? `<ul>${holdingsHtml}</ul>` : 'none'}</span></div>
                    <div class="portfolio-share-row"><span>Cash</span><span>${p.account.cashBalance != null ? esc(fmt(p.account.cashBalance)) : 'not tracked'}</span></div>
                    <div class="portfolio-share-row"><span>Transactions</span><span>${p.transactions.length ? `${p.transactions.length}${first ? `, ${esc(first)} to ${esc(last)}` : ''}` : 'none'}</span></div>
                    <div class="portfolio-share-row is-quiet"><span>Not shared</span><span>Your notes, decisions and strategy, the brokerage connection, and every other account.</span></div>
                </div>`,
            buttons: [
                { text: 'Cancel', className: 'secondary-btn', onClick: () => modal.close() },
                { text: 'Share', className: 'primary-btn', onClick: () => {
                    const contactId = modal.element.querySelector('#portfolio-share-contact')?.value;
                    modal.close();
                    if (!contactId) return;
                    const s = this.share(accountId, contactId);
                    if (s) this._toast(`Sharing “${account.name}” with ${this.contactLabel(contactId)}`, 'success');
                    this._renderIfVisible();
                } },
            ],
        });
    },

    /** An offer row in the nav opens this: accept or decline, with the preview. */
    showOfferModal(shareId) {
        const o = this._offers()[shareId];
        if (!o) return;
        const p = this.sanitizeProjection(o.projection);
        if (!p) { this.decline(shareId); return; }
        const esc = (s) => (typeof UIUtils !== 'undefined' ? UIUtils.escapeHtml(String(s ?? '')) : String(s ?? ''));
        const fmt = (n) => (typeof PortfolioUI !== 'undefined' ? PortfolioUI.formatMoney(n) : String(n));
        const who = this.contactLabel(o.contactId);
        const modal = Modal.create({
            title: `${esc(who)} wants to share “${esc(p.account.name)}”`,
            className: 'portfolio-link-modal portfolio-share-modal',
            content: `
                <p class="portfolio-link-lede">Read-only. It appears under “Shared with you” in your Portfolio and updates when ${esc(who)}’s copy changes; it never counts in your own totals. It is removed when ${esc(who)} stops sharing, or on its own if nothing arrives for ${this.LEASE_DAYS} days.</p>
                <div class="portfolio-share-preview">
                    <div class="portfolio-share-row"><span>Positions</span><span>${p.holdings.length}</span></div>
                    <div class="portfolio-share-row"><span>Cash</span><span>${p.account.cashBalance != null ? esc(fmt(p.account.cashBalance)) : 'not tracked'}</span></div>
                    <div class="portfolio-share-row"><span>Transactions</span><span>${p.transactions.length}</span></div>
                </div>`,
            buttons: [
                { text: 'Decline', className: 'secondary-btn', onClick: () => { modal.close(); this.decline(shareId); } },
                { text: 'Accept', className: 'primary-btn', onClick: () => { modal.close(); this.accept(shareId); this._toast(`“${p.account.name}” is now in your Portfolio`, 'success'); } },
            ],
        });
    },
};

if (typeof module !== 'undefined' && module.exports) module.exports = PortfolioSharing;
// Self-start in the renderer: the Portfolio package is lazy (its init runs
// on first open), but an offer or a revoke from a contact has to be heard
// whether or not the user opens Portfolio this session. Deferred a tick so
// the sibling scripts of the package have loaded; a no-op with the flag off.
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    setTimeout(() => { try { PortfolioSharing.init(); } catch (e) { console.warn('[sharing] init failed', e); } }, 0);
}
