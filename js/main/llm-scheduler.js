'use strict';

// Request permits belong to inference resources, not provider names. Foreground
// dependencies use interactive priority even when their response is not streamed.
// Permits cover one dispatch only; never hold one while requesting another.
class LLMScheduler {
    constructor({ now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
        cooldownMs = 20000, backgroundMaxWaitMs = 60000 } = {}) {
        Object.assign(this, { now, setTimer, clearTimer, cooldownMs, backgroundMaxWaitMs });
        this.resources = new Map();
        this.stats = { bgRun: 0, bgWaitTotalMs: 0, bgWaitMaxMs: 0,
            interactiveRun: 0, interactiveWaitTotalMs: 0, interactiveWaitMaxMs: 0,
            cancelledQueued: 0 };
        this.serialAll = true; // shared local hardware starts with one dispatch
    }

    acquire(jobClass, resource, meta = {}) {
        // Keep the old Boolean seam for callers outside the ordinary transport.
        if (resource === true) resource = { key: 'local-inference', kind: 'local', capacity: 1 };
        if (!resource) return Promise.resolve({ release() {}, waitMs: 0 });
        const signal = meta.signal;
        if (signal?.aborted) return Promise.reject(this._aborted());
        let group = this.resources.get(resource.key);
        if (!group) {
            group = { key: resource.key, kind: resource.kind, capacity: 1,
                queue: [], active: new Set(), lastInteractiveEnd: null, timer: null,
                touched: this.now() };
            this.resources.set(group.key, group);
            this._prune();
        }
        group.capacity = Math.max(1, Math.min(8, Math.trunc(resource.capacity) || 1));
        group.touched = this.now();
        return new Promise((resolve, reject) => {
            const job = { jobClass: jobClass === 'interactive' ? 'interactive' : 'background',
                turnId: meta.turnId,
                enqueued: this.now(), resolve, reject, signal, cancel: null };
            job.cancel = (drain = true) => {
                const index = group.queue.indexOf(job);
                if (index < 0) return; // dispatched requests release in transport finally
                group.queue.splice(index, 1);
                signal?.removeEventListener('abort', job.cancel);
                this.stats.cancelledQueued++;
                reject(this._aborted());
                if (drain) this._drain(group);
            };
            group.queue.push(job);
            signal?.addEventListener('abort', job.cancel, { once: true });
            if (signal?.aborted) job.cancel();
            else this._drain(group);
        });
    }

    _aborted() {
        const error = new Error('Request cancelled before dispatch');
        error.name = 'AbortError';
        error.code = 'ABORT_ERR';
        return error;
    }

    cancelQueued(turnId) {
        if (!turnId) return 0;
        let count = 0;
        const affected = new Set();
        for (const group of this.resources.values()) {
            for (const job of group.queue.slice()) {
                if (job.turnId !== turnId || !group.queue.includes(job)) continue;
                job.cancel(false);
                affected.add(group);
                count++;
            }
        }
        for (const group of affected) this._drain(group);
        return count;
    }

    _arm(group, delay) {
        if (group.timer != null) this.clearTimer(group.timer);
        group.timer = this.setTimer(() => {
            group.timer = null;
            this._drain(group);
        }, Math.max(1, delay));
        group.timer?.unref?.();
    }

    _drain(group) {
        if (group.timer != null) { this.clearTimer(group.timer); group.timer = null; }
        while (group.active.size < group.capacity && group.queue.length) {
            const now = this.now();
            const foreground = group.queue.findIndex(j => j.jobClass === 'interactive');
            const background = group.queue.findIndex(j => j.jobClass === 'background');
            const backgroundActive = [...group.active].some(j => j.jobClass === 'background');
            const interactiveActive = [...group.active].some(j => j.jobClass === 'interactive');
            const aged = background >= 0
                && now - group.queue[background].enqueued >= this.backgroundMaxWaitMs;
            let index = -1;
            // One ambient request at a time. An aged request gets a bounded
            // opportunity between foreground dispatches instead of starving.
            if (aged && !backgroundActive) index = background;
            else if (foreground >= 0) index = foreground;
            else if (background >= 0 && !backgroundActive && !interactiveActive) {
                const cooldown = group.lastInteractiveEnd == null ? 0
                    : this.cooldownMs - (now - group.lastInteractiveEnd);
                if (cooldown <= 0) index = background;
                else this._arm(group, Math.min(cooldown,
                    this.backgroundMaxWaitMs - (now - group.queue[background].enqueued)));
            } else if (background >= 0 && !backgroundActive) {
                this._arm(group, this.backgroundMaxWaitMs - (now - group.queue[background].enqueued));
            }
            if (index < 0) break;
            const job = group.queue.splice(index, 1)[0];
            job.signal?.removeEventListener('abort', job.cancel);
            group.active.add(job);
            const waitMs = Math.max(0, now - job.enqueued);
            const interactive = job.jobClass === 'interactive';
            const count = interactive ? 'interactiveRun' : 'bgRun';
            const total = interactive ? 'interactiveWaitTotalMs' : 'bgWaitTotalMs';
            const max = interactive ? 'interactiveWaitMaxMs' : 'bgWaitMaxMs';
            this.stats[count]++;
            this.stats[total] += waitMs;
            this.stats[max] = Math.max(this.stats[max], waitMs);
            let released = false;
            job.resolve({ waitMs, resource: group.key, release: () => {
                if (released) return;
                released = true;
                group.active.delete(job);
                group.touched = this.now();
                if (interactive) group.lastInteractiveEnd = this.now();
                this._drain(group);
            } });
        }
    }

    _prune() {
        if (this.resources.size <= 128) return;
        for (const group of [...this.resources.values()].sort((a, b) => a.touched - b.touched)) {
            if (!group.active.size && !group.queue.length && group.timer == null
                && this.now() - group.touched >= this.cooldownMs) this.resources.delete(group.key);
            if (this.resources.size <= 128) break;
        }
    }

    snapshot() {
        const resources = [...this.resources.values()].map(group => ({
            id: group.key, kind: group.kind, capacity: group.capacity,
            interactiveActive: [...group.active].filter(j => j.jobClass === 'interactive').length,
            backgroundActive: [...group.active].filter(j => j.jobClass === 'background').length,
            interactiveQueued: group.queue.filter(j => j.jobClass === 'interactive').length,
            bgQueued: group.queue.filter(j => j.jobClass === 'background').length
        }));
        const s = this.stats;
        return { ...s, serialAll: this.serialAll,
            bgWaitAvgMs: s.bgRun ? Math.round(s.bgWaitTotalMs / s.bgRun) : 0,
            interactiveWaitAvgMs: s.interactiveRun ? Math.round(s.interactiveWaitTotalMs / s.interactiveRun) : 0,
            interactiveActive: resources.reduce((n, r) => n + r.interactiveActive, 0),
            backgroundActive: resources.reduce((n, r) => n + r.backgroundActive, 0),
            bgQueued: resources.reduce((n, r) => n + r.bgQueued, 0), resources };
    }
}

module.exports = { LLMScheduler };
