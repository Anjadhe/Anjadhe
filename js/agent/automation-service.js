/**
 * Automations — unattended task triggers (docs/COWORK_AGENT.md C8.5).
 *
 * An assistant that only works while you watch is a chatbot with tools.
 * An automation arms a TASK to start without a human present: on a time
 * cadence (same interval + wall-clock-anchor shape as PromptFeed), on a new
 * email matching a rule, or on a file landing in a folder. The arming step
 * is the explicit auto-run consent C4 requires — creation goes through the
 * consent-gated create_automation tool, and nothing else in the app
 * auto-runs a task.
 *
 * One runner, one task at a time: the tick fires at most one automation per
 * pass, and TaskService.start's one-task-at-a-time refusal simply leaves the
 * trigger unstamped so it retries next tick (same serialization philosophy
 * as PromptFeed's single-generation tick).
 *
 * Storage: `agent-automations`, machine-local (SYNC_EXCLUDE) — an
 * automation runs on the Mac that armed it. Syncing it would run the same
 * trigger on every Mac at once, and unattended double-writes are exactly
 * what nobody wants.
 */
const AutomationService = {
    STORE_KEY: 'agent-automations',
    MAX_AUTOMATIONS: 20,
    POLL_MS: 60 * 1000,
    INTERVAL_MS: { hourly: 60 * 60 * 1000, daily: 24 * 60 * 60 * 1000, weekly: 7 * 24 * 60 * 60 * 1000 },

    _timer: null,
    _busy: false,

    all() {
        const v = StorageManager.get(this.STORE_KEY);
        return Array.isArray(v) ? v.filter(Boolean) : [];
    },

    get(id) { return this.all().find(a => a.id === id) || null; },

    _saveAll(list) { StorageManager.set(this.STORE_KEY, list.slice(0, this.MAX_AUTOMATIONS)); },

    /**
     * Validate + arm. trigger:
     *   {type:'time', interval:'hourly'|'daily'|'weekly', time?:'HH:MM'}
     *   {type:'email', from?:string, subject?:string}   (substring match, at least one)
     *   {type:'file', folder:string, pattern?:string}
     */
    create({ goal, trigger } = {}) {
        const g = String(goal || '').trim();
        if (!g) return { error: 'goal required' };
        if (this.all().length >= this.MAX_AUTOMATIONS) return { error: `limit of ${this.MAX_AUTOMATIONS} automations reached — remove one first (Tasks page)` };
        const t = trigger && typeof trigger === 'object' ? trigger : {};
        let clean;
        if (t.type === 'time') {
            const interval = ['hourly', 'daily', 'weekly'].includes(t.interval) ? t.interval : 'daily';
            clean = { type: 'time', interval };
            if (t.time && /^\d{1,2}:\d{2}$/.test(String(t.time))) clean.time = String(t.time).padStart(5, '0');
        } else if (t.type === 'email') {
            const from = String(t.from || '').trim().slice(0, 120);
            const subject = String(t.subject || '').trim().slice(0, 120);
            if (!from && !subject) return { error: 'an email trigger needs a from and/or subject match' };
            clean = { type: 'email' };
            if (from) clean.from = from;
            if (subject) clean.subject = subject;
        } else if (t.type === 'file') {
            const folder = String(t.folder || '').trim();
            if (!folder) return { error: 'a file trigger needs a folder path' };
            clean = { type: 'file', folder: folder.slice(0, 300) };
            if (t.pattern) clean.pattern = String(t.pattern).trim().slice(0, 80);
        } else {
            return { error: 'trigger.type must be time, email, or file' };
        }
        const automation = {
            id: `auto_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
            goal: g.slice(0, 500),
            trigger: clean,
            enabled: true,
            createdAt: new Date().toISOString(),
            lastRunAt: null,
            lastTaskId: null,
            lastError: null
        };
        this._saveAll([automation, ...this.all()]);
        return { automation };
    },

    remove(id) { this._saveAll(this.all().filter(a => a.id !== id)); },

    setEnabled(id, on) {
        const list = this.all();
        const a = list.find(x => x.id === id);
        if (a) { a.enabled = !!on; this._saveAll(list); }
    },

    triggerLabel(a) {
        const t = a.trigger || {};
        if (t.type === 'time') return t.time ? `${t.interval} at ${t.time}` : t.interval;
        if (t.type === 'email') {
            const bits = [];
            if (t.from) bits.push(`from "${t.from}"`);
            if (t.subject) bits.push(`subject "${t.subject}"`);
            return `new email ${bits.join(', ')}`;
        }
        if (t.type === 'file') return `new file in ${t.folder}${t.pattern ? ` (${t.pattern})` : ''}`;
        return 'unknown trigger';
    },

    init() {
        if (this._timer) return;
        setTimeout(() => this.tick().catch(() => {}), 20000);
        this._timer = setInterval(() => this.tick().catch(() => {}), this.POLL_MS);
    },

    _notify(title, body) {
        try { new Notification(title, { body: String(body || '').slice(0, 180), silent: false }); }
        catch { /* notifications are best-effort */ }
    },

    async tick() {
        if (this._busy) return;
        if (typeof AgentService === 'undefined' || !AgentService.model) return;
        if (typeof TaskService === 'undefined') return;
        const now = Date.now();
        this._busy = true;
        try {
            for (const a of this.all()) {
                if (!a.enabled) continue;
                let fire = null;
                try { fire = await this._checkTrigger(a, now); } catch { continue; }
                if (!fire) continue;
                await this._fire(a, fire);
                break;   // at most one unattended start per tick
            }
        } finally {
            this._busy = false;
        }
    },

    async _fire(a, context) {
        const goal = context && context.suffix ? `${a.goal}\n\n${context.suffix}` : a.goal;
        const res = await TaskService.start(goal, null, { unattended: true, automationId: a.id });
        const list = this.all();
        const live = list.find(x => x.id === a.id);
        if (!live) return;
        if (res && res.error) {
            // "Another task is already running" stays unstamped on purpose —
            // the trigger retries next tick instead of silently skipping.
            if (!/already running/i.test(res.error)) {
                live.lastError = String(res.error).slice(0, 200);
                live.lastRunAt = new Date().toISOString();
                this._saveAll(list);
                this._notify('Automation could not start', `${a.goal.slice(0, 80)} — ${live.lastError}`);
            }
            return;
        }
        live.lastRunAt = new Date().toISOString();
        live.lastTaskId = res.taskId;
        live.lastError = null;
        this._saveAll(list);
    },

    /** Manual "Run now" from the Tasks page — bypasses the due check. */
    async runNow(id) {
        const a = this.get(id);
        if (!a) return { error: 'automation not found' };
        await this._fire(a, null);
        return { ok: true };
    },

    async _checkTrigger(a, now) {
        const t = a.trigger || {};
        const lastMs = a.lastRunAt ? Date.parse(a.lastRunAt) : 0;
        const armedMs = Date.parse(a.createdAt) || now;

        if (t.type === 'time') {
            // Same anchor logic as PromptFeed._isDue: a preferred wall-clock
            // time is due once its most recent occurrence hasn't run yet.
            if (t.time && (t.interval === 'daily' || t.interval === 'weekly')) {
                const [h, m] = t.time.split(':').map(Number);
                const occ = new Date(now);
                occ.setHours(h, m, 0, 0);
                if (occ.getTime() > now) occ.setDate(occ.getDate() - 1);
                if (occ.getTime() < armedMs) return null;   // never fire for a slot armed after it passed
                if (lastMs >= occ.getTime()) return null;
                if (t.interval === 'weekly' && lastMs && (now - lastMs) < 6 * this.INTERVAL_MS.daily) return null;
                return { suffix: null };
            }
            const span = this.INTERVAL_MS[t.interval] || this.INTERVAL_MS.daily;
            return (now - (lastMs || armedMs)) >= span ? { suffix: null } : null;
        }

        if (t.type === 'email') {
            const emails = (StorageManager.get('email')?.emails) || [];
            const sinceMs = Math.max(lastMs, armedMs);
            const from = (t.from || '').toLowerCase();
            const subject = (t.subject || '').toLowerCase();
            const hit = emails.find(e => {
                const ts = Date.parse(e.date) || 0;
                if (ts <= sinceMs) return false;
                if (from && !(String(e.from || '').toLowerCase().includes(from))) return false;
                if (subject && !(String(e.subject || '').toLowerCase().includes(subject))) return false;
                return true;
            });
            if (!hit) return null;
            return { suffix: `Triggered by a new email — subject: "${hit.subject || '(no subject)'}", from: ${hit.from || 'unknown'}.` };
        }

        if (t.type === 'file') {
            if (!window.electronAgentFS?.list) return null;
            const r = await window.electronAgentFS.list(t.folder, t.pattern || undefined);
            if (r.error) {
                // Folder not granted / gone: surface once, don't spin.
                const list = this.all();
                const live = list.find(x => x.id === a.id);
                if (live && live.lastError !== r.error.slice(0, 200)) {
                    live.lastError = r.error.slice(0, 200);
                    this._saveAll(list);
                }
                return null;
            }
            const sinceMs = Math.max(lastMs, armedMs);
            const hit = (r.entries || []).find(e => !e.dir && e.mtime && Date.parse(e.mtime) > sinceMs);
            if (!hit) return null;
            const sep = t.folder.endsWith('/') ? '' : '/';
            return { suffix: `Triggered by a new file: ${t.folder}${sep}${hit.name}` };
        }

        return null;
    }
};

if (typeof window !== 'undefined') {
    window.AutomationService = AutomationService;
    setTimeout(() => { try { AutomationService.init(); } catch { /* optional */ } }, 0);
}
