const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

const LlamaCppManager = require('./llamacpp-manager');

/**
 * EmbedManager — the local embedding engine (docs/LIBRARY.md, phase L0).
 *
 * A SECOND managed llama-server, kept deliberately separate from the chat
 * one: one process = one model stays true for each process, the chat
 * server's load/restart churn never evicts the embedder, and a crash in
 * either is isolated. The model is a ~300M embedding GGUF (~0.5 GB RSS) —
 * negligible beside a chat model, and the only AI component the Library
 * pins to this Mac (law V3: the corpus is indexed locally no matter which
 * brain the user selected; search must work offline even when a hosted
 * brain is away).
 *
 * Reuses the chat manager's engine binary and download machinery; weights
 * live in their own ~/.anjadhe_llamacpp/embed-models/ so the chat model
 * list never shows an embedding model as a chat option.
 *
 * Lifecycle: spawn on first embed() call, stop after IDLE_STOP_MS without
 * one — indexing is bursty and 1–2 s of cold start on the next burst is
 * cheaper than holding RAM forever.
 */
const EmbedManager = {
    // Away from the chat server's 18434 home AND its 18435-18440
    // EADDRINUSE fallover range.
    port: 18444,
    process: null,
    isReady: false,
    apiKey: null,
    loadedFile: null,
    _quitting: false,
    _loading: null,        // in-flight ensureReady promise — coalesces callers
    _idleTimer: null,
    IDLE_STOP_MS: 10 * 60 * 1000,
    // Texts per /v1/embeddings request. Each text is ≤ the model ctx; small
    // batches bound per-request latency and keep a failed request cheap.
    BATCH_SIZE: 16,

    /**
     * The active embedding-model spec, set by main.js from remote config
     * (with a bundled fallback) before any call:
     * { name, gguf: {url, file, sha256}, dims, storeDims, ctx, pooling,
     *   prefixes: {query, document} }.
     * `storeDims` is the Matryoshka truncation the index stores; it is part
     * of the index identity (LibraryStore stamps `${name}@${storeDims}`).
     */
    spec: null,

    get modelsDir() { return path.join(LlamaCppManager.home, 'embed-models'); },
    _ggufPath() { return this.spec ? path.join(this.modelsDir, this.spec.gguf.file) : null; },

    // ANJADHE_EMBED_OFF=1 (evals): behave as if no embedding model exists,
    // whatever the shared ~/.anjadhe_llamacpp holds. The engine dir is
    // deliberately NOT redirected by ANJADHE_DATA_ROOT (multi-GB weights),
    // so the det suite's keyword-degrade journeys went nondeterministic the
    // day the host downloaded the model — this pins them.
    get disabled() { return process.env.ANJADHE_EMBED_OFF === '1'; },

    /** Engine installed AND the pinned embedding model downloaded. */
    isInstalled() {
        if (this.disabled) return false;
        const p = this._ggufPath();
        return !!(LlamaCppManager.getBinaryPath() && p && fs.existsSync(p));
    },

    status() {
        return {
            engineInstalled: !!LlamaCppManager.getBinaryPath(),
            modelDownloaded: !this.disabled && !!(this._ggufPath() && fs.existsSync(this._ggufPath())),
            model: this.spec ? this.spec.name : null,
            storeDims: this.spec ? this.spec.storeDims : null,
            running: !!this.process,
            ready: this.isReady
        };
    },

    /**
     * Download the pinned embedding model (verified, resumable — the chat
     * manager's downloader). Idempotent; safe to call when already on disk.
     */
    async pullModel(onProgress) {
        if (!this.spec) throw new Error('No embedding model configured');
        const { url, file, sha256 } = this.spec.gguf;
        fs.mkdirSync(this.modelsDir, { recursive: true });
        const finalPath = path.join(this.modelsDir, file);
        if (!fs.existsSync(finalPath)) {
            await LlamaCppManager._downloadVerified(
                url, finalPath, sha256, `Embedding model "${this.spec.name}"`, onProgress, 'Downloading');
        }
        if (onProgress) onProgress({ status: 'Done', percent: 100, completed: null, total: null });
        return { success: true };
    },

    _checkHealth(port, timeoutMs = 2000) {
        return new Promise((resolve) => {
            const req = http.request({
                hostname: '127.0.0.1', port, path: '/health', method: 'GET', timeout: timeoutMs
            }, (res) => {
                res.resume();
                if (res.statusCode === 200) resolve('ready');
                else if (res.statusCode === 503) resolve('loading');
                else resolve('other');
            });
            req.on('error', () => resolve('free'));
            req.on('timeout', () => { req.destroy(); resolve('free'); });
            req.end();
        });
    },

    /** Authenticated identity probe — same rationale as the chat manager's
     *  _checkOwn: /health can't tell our spawn from an orphan's. */
    _checkOwn(port, timeoutMs = 2000) {
        return new Promise((resolve) => {
            const req = http.request({
                hostname: '127.0.0.1', port, path: '/v1/models', method: 'GET', timeout: timeoutMs,
                headers: this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}
            }, (res) => { res.resume(); resolve(res.statusCode); });
            req.on('error', () => resolve(null));
            req.on('timeout', () => { req.destroy(); resolve(null); });
            req.end();
        });
    },

    async _waitForReady(port, retries = 60) {
        for (let i = 0; i < retries; i++) {
            if (!this.process) return false;
            // eslint-disable-next-line no-await-in-loop
            if ((await this._checkOwn(port)) === 200) return true;
            // eslint-disable-next-line no-await-in-loop
            await new Promise(r => setTimeout(r, 1000));
        }
        return false;
    },

    _spawn(binaryPath, port, ggufPath) {
        this.apiKey = crypto.randomBytes(24).toString('hex');
        const ctx = this.spec.ctx || 2048;
        const args = [
            '-m', ggufPath,
            '--host', '127.0.0.1',
            '--port', String(port),
            '--embeddings',
            '--pooling', this.spec.pooling || 'mean',
            // The non-causal batch law: an embedding input must fit ONE
            // physical batch (n_ubatch >= n_tokens) or the server asserts.
            // -ub = ctx and the chunker guarantees chunk+prefix <= ctx.
            '-c', String(ctx),
            '-b', String(ctx),
            '-ub', String(ctx),
            '-ngl', '99',
            '--alias', 'embed',
            '--api-key', this.apiKey,
            '--no-webui'
        ];
        const child = spawn(binaryPath, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: false });
        child.stdout.on('data', (d) => console.log('[embed]', d.toString().trim()));
        child.stderr.on('data', (d) => console.log('[embed]', d.toString().trim()));
        child.on('exit', (code) => {
            console.log(`[embed] Process exited with code ${code}`);
            if (this.process !== child && this.process !== null) return;
            this.process = null;
            this.isReady = false;
            this.loadedFile = null;
        });
        return child;
    },

    /** Make sure the embedding server is up. Coalesces concurrent callers. */
    async ensureReady() {
        if (this.disabled) throw new Error('Embedding engine disabled (ANJADHE_EMBED_OFF)');
        if (!this.spec) throw new Error('No embedding model configured');
        while (this._loading) {
            await this._loading.catch(() => {});
        }
        const ggufPath = this._ggufPath();
        if (this.isReady && this.process && this.loadedFile === ggufPath) return true;
        this._loading = this._start(ggufPath);
        try {
            return await this._loading;
        } finally {
            this._loading = null;
        }
    },

    async _start(ggufPath) {
        const binaryPath = LlamaCppManager.getBinaryPath();
        if (!binaryPath) throw new Error('llama.cpp engine is not installed');
        if (!fs.existsSync(ggufPath)) throw new Error('Embedding model is not downloaded');

        if (this.process) {
            this.stop(false);
            for (let i = 0; i < 10; i++) {
                // eslint-disable-next-line no-await-in-loop
                if ((await this._checkHealth(this.port)) === 'free') break;
                // eslint-disable-next-line no-await-in-loop
                await new Promise(r => setTimeout(r, 500));
            }
        }
        // Port taken by something we don't own (orphan from a dead session):
        // step to a nearby port rather than killing — the embedder is cheap
        // to relocate and an orphan reaper already exists for the chat range.
        if ((await this._checkHealth(this.port)) !== 'free') {
            for (let p = 18445; p <= 18448; p++) {
                // eslint-disable-next-line no-await-in-loop
                if ((await this._checkHealth(p)) === 'free') {
                    console.log(`[embed] Port ${this.port} is taken — using ${p}`);
                    this.port = p;
                    break;
                }
            }
        }
        this._quitting = false;
        console.log(`[embed] Starting embedding server: ${this.spec.name}`);
        this.process = this._spawn(binaryPath, this.port, ggufPath);
        const ready = await this._waitForReady(this.port);
        if (ready) {
            this.isReady = true;
            this.loadedFile = ggufPath;
            console.log(`[embed] Ready on port ${this.port} (${this.spec.name})`);
        } else {
            if (this.process) { this.process.kill(); this.process = null; }
            throw new Error(`Embedding server failed to load ${this.spec.name}`);
        }
        return ready;
    },

    stop(quitting = true) {
        if (quitting) this._quitting = true;
        if (this._idleTimer) { clearTimeout(this._idleTimer); this._idleTimer = null; }
        if (this.process) {
            console.log('[embed] Stopping embedding server');
            this.process.kill('SIGTERM');
            const pid = this.process.pid;
            setTimeout(() => {
                try { process.kill(pid, 0); process.kill(pid, 'SIGKILL'); } catch {}
            }, 5000);
            this.process = null;
        }
        this.isReady = false;
        this.loadedFile = null;
    },

    _touchIdle() {
        if (this._idleTimer) clearTimeout(this._idleTimer);
        this._idleTimer = setTimeout(() => {
            this._idleTimer = null;
            if (this.process) {
                console.log('[embed] Idle — stopping embedding server');
                this.stop(false);
            }
        }, this.IDLE_STOP_MS);
    },

    /** One authenticated /v1/embeddings POST for a batch of texts. */
    _request(texts) {
        const body = JSON.stringify({ model: 'embed', input: texts });
        return new Promise((resolve, reject) => {
            const req = http.request({
                hostname: '127.0.0.1', port: this.port, path: '/v1/embeddings', method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(body),
                    Authorization: `Bearer ${this.apiKey}`
                },
                timeout: 120000
            }, (res) => {
                let out = '';
                res.on('data', (d) => { out += d; });
                res.on('end', () => {
                    if (res.statusCode !== 200) { reject(new Error(`embeddings HTTP ${res.statusCode}: ${out.slice(0, 200)}`)); return; }
                    try {
                        const parsed = JSON.parse(out);
                        resolve(parsed.data.map(d => d.embedding));
                    } catch (e) { reject(e); }
                });
            });
            req.on('error', reject);
            req.on('timeout', () => req.destroy(new Error('embeddings request timed out')));
            req.end(body);
        });
    },

    /**
     * Matryoshka truncation + re-normalization. /v1/embeddings returns the
     * full-width vector L2-normalized; a truncated slice is NOT unit-length
     * any more, and cosine-via-dot-product depends on it being one.
     */
    _truncate(vec, dims) {
        const out = new Float32Array(dims);
        let norm = 0;
        for (let i = 0; i < dims; i++) { out[i] = vec[i]; norm += vec[i] * vec[i]; }
        norm = Math.sqrt(norm) || 1;
        for (let i = 0; i < dims; i++) out[i] /= norm;
        return out;
    },

    /**
     * Embed texts → Float32Array[storeDims] each. `kind` picks the task
     * prefix ('query' | 'document') — MANDATORY and asymmetric for the
     * pinned models; the server does not add them, and mixing them silently
     * degrades retrieval. Callers pass RAW text; the prefix template lives
     * in the spec so it changes with the model pin, never in caller code.
     */
    async embed(texts, kind = 'document') {
        if (!Array.isArray(texts) || !texts.length) return [];
        await this.ensureReady();
        this._touchIdle();
        const tpl = (this.spec.prefixes && this.spec.prefixes[kind]) || '{text}';
        const prefixed = texts.map(t => tpl.replace('{text}', String(t)));
        const dims = this.spec.storeDims || this.spec.dims;
        const out = [];
        for (let i = 0; i < prefixed.length; i += this.BATCH_SIZE) {
            // eslint-disable-next-line no-await-in-loop
            const vecs = await this._request(prefixed.slice(i, i + this.BATCH_SIZE));
            for (const v of vecs) out.push(this._truncate(v, dims));
            this._touchIdle();
        }
        return out;
    }
};

module.exports = EmbedManager;
