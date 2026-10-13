'use strict';
const { token } = require('./record-merge');
const MAX = 13 * 1024 * 1024;
const positive = n => Number.isSafeInteger(n) && n > 0;
const knownErrors = new Set(['unauthorized', 'epoch_changed', 'identity_reused', 'sequence_gap', 'invalid_envelope',
    'invalid_cursor', 'frontier_ahead', 'storage_quota', 'rate_limited', 'storage_unavailable', 'batch_too_large']);
class MailboxError extends Error {
    constructor(code, status = 0) { super(code); this.code = code; this.status = status; }
}
function canceled(signal) { if (signal?.aborted) throw new MailboxError('canceled'); }

// Dedicated sync credential, not an inference key. Construction performs no
// enrollment or requests. Every response is bounded and redirects are refused.
class MailboxClient {
    constructor({ baseURL = 'https://api.nenva.co', credential, fetchImpl = globalThis.fetch }) {
        const base = new URL(baseURL);
        if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || base.pathname !== '/' ||
            typeof credential !== 'string' || credential.length !== 70 || !/^nsync_[a-f0-9]{64}$/.test(credential) || typeof fetchImpl !== 'function') throw new MailboxError('invalid_configuration');
        this.base = base; this.credential = credential; this.fetch = fetchImpl;
    }
    async _request({ dataset, epoch, resource, body, cursor, signal }) {
        if (!token(dataset) || !positive(epoch)) throw new MailboxError('invalid_configuration');
        canceled(signal);
        const url = new URL(`/v2/sync/datasets/${dataset}/${resource}`, this.base);
        if (cursor !== undefined) url.searchParams.set('after', cursor);
        const headers = { Authorization: `Bearer ${this.credential}`, 'X-Sync-Epoch': String(epoch), Accept: 'application/json' };
        const payload = body === undefined ? undefined : JSON.stringify(body);
        if (payload && Buffer.byteLength(payload) > MAX) throw new MailboxError('invalid_response');
        if (payload) headers['Content-Type'] = 'application/json';
        const controller = new AbortController(), abort = () => controller.abort();
        signal?.addEventListener('abort', abort, { once: true });
        const timer = setTimeout(abort, 30000); timer.unref?.();
        let reader;
        try {
            const response = await this.fetch(url, { method: body === undefined ? 'GET' : 'POST', headers, body: payload,
                redirect: 'error', cache: 'no-store', credentials: 'omit', signal: controller.signal });
            // Injected transports obey the same redirect contract as fetch.
            if (response.redirected || !response.body) throw new MailboxError('invalid_response');
            reader = response.body.getReader();
            const chunks = []; let count = 0;
            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                count += value.byteLength;
                if (count > MAX) throw new MailboxError('invalid_response');
                chunks.push(Buffer.from(value));
            }
            canceled(signal);
            let result;
            try { result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, count))); } catch { /* sanitized below */ }
            if (response.status !== 200) throw new MailboxError(knownErrors.has(result?.error) ? result.error : 'request_failed', response.status);
            if (!result || typeof result !== 'object' || Array.isArray(result)) throw new MailboxError('invalid_response');
            return result;
        } finally {
            clearTimeout(timer); signal?.removeEventListener('abort', abort);
            try { await reader?.cancel(); } catch { /* best effort after completion/abort */ }
        }
    }
    async upload({ dataset, epoch = 1, envelopes, signal }) {
        if (!Array.isArray(envelopes) || !envelopes.length || envelopes.length > 256) throw new MailboxError('invalid_response');
        const result = await this._request({ dataset, epoch, resource: 'operations', body: { envelopes }, signal });
        if (!positive(result.storedThrough)) throw new MailboxError('invalid_response');
        return result.storedThrough;
    }
    async download({ dataset, epoch = 1, cursor, signal }) {
        const validCursor = s => typeof s === 'string' && Buffer.byteLength(s) <= 2048 && !s.includes('\0');
        if (!validCursor(cursor)) throw new MailboxError('invalid_response');
        const result = await this._request({ dataset, epoch, resource: 'operations', cursor, signal });
        if (!Array.isArray(result.envelopes) || result.envelopes.length > 256 || !validCursor(result.nextCursor) || typeof result.hasMore !== 'boolean') throw new MailboxError('invalid_response');
        return result;
    }
    async acknowledge({ dataset, epoch = 1, frontier, signal }) {
        if (!frontier || typeof frontier !== 'object' || Array.isArray(frontier) || Object.keys(frontier).length > 32 ||
            Object.entries(frontier).some(([w, n]) => !token(w) || !Number.isSafeInteger(n) || n < 0)) throw new MailboxError('invalid_response');
        const result = await this._request({ dataset, epoch, resource: 'receipts', body: { frontier }, signal });
        if (result.accepted !== true) throw new MailboxError('invalid_response');
    }
}

// Bounded foreground pass, matching MergeDeliveryCoordinator.swift. The
// enrollment layer owns the immutable key/membership snapshot. No automatic
// startup, retry scheduler, workflow execution or v1-to-v2 migration here.
class MacDeliveryCoordinator {
    constructor({ store, transport, dataset, epoch = 1, datasetKey, signingSeed, authorizedWriters }) {
        this.store = store; this.transport = transport; this.dataset = dataset; this.epoch = epoch;
        this.datasetKey = Buffer.from(datasetKey); this.signingSeed = Buffer.from(signingSeed);
        this.authorizedWriters = Object.fromEntries(Object.entries(authorizedWriters).map(([id, key]) => [id, Buffer.from(key)]));
        this.running = false;
    }
    async synchronize({ pageBudget = 8, signal } = {}) {
        if (!positive(pageBudget) || pageBudget > 32) throw new MailboxError('invalid_budget');
        if (this.running) throw new MailboxError('already_running');
        this.running = true;
        const { dataset, epoch, datasetKey, signingSeed, authorizedWriters } = this;
        try {
            for (let i = 0; i < pageBudget; i++) {
                canceled(signal);
                const state = this.store.deliveryState(dataset, epoch);
                const envelopes = this.store.encryptedOutbox({ dataset, epoch, datasetKey, signingSeed, after: state.uploadedSequence });
                if (!envelopes.length) break;
                const through = await this.transport.upload({ dataset, epoch, envelopes, signal });
                canceled(signal);
                if (through !== envelopes[envelopes.length - 1].sequence) throw new MailboxError('invalid_acknowledgment');
                this.store.confirmUpload(dataset, epoch, state.uploadedSequence, through);
            }
            for (let i = 0; i < pageBudget; i++) {
                canceled(signal);
                const state = this.store.deliveryState(dataset, epoch);
                const page = await this.transport.download({ dataset, epoch, cursor: state.cursor, signal });
                canceled(signal);
                if (page.hasMore && page.nextCursor === state.cursor) throw new MailboxError('invalid_page');
                const receipt = this.store.ingestEncryptedPage({ dataset, epoch, datasetKey, authorizedWriters,
                    envelopes: page.envelopes, expectedCursor: state.cursor, nextCursor: page.nextCursor });
                await this.transport.acknowledge({ dataset, epoch, frontier: receipt.frontier, signal });
                if (!page.hasMore) break;
            }
            return this.store.deliveryState(dataset, epoch);
        } finally { this.running = false; }
    }
}
module.exports = { MailboxClient, MacDeliveryCoordinator, MailboxError };
