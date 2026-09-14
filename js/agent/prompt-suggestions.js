/**
 * PromptSuggestions — the "Try asking…" pills, written by the brain from
 * what is actually on the user's plate (2026-09-10, by request: "suggested
 * prompts … could be based on user's data and settings instead of being
 * static … generated every one hour dynamically based on the usage").
 *
 * Shape:
 *  - A FACT SHEET (pure `factSheet`, pinned by tests/prompt-suggestions-
 *    test.js) is built from cheap reads: the hour and weekday, which apps
 *    are on and which the user opens most, what setup is still pending,
 *    counts and a few titles from Tasks / Projects / Calendar / Notes /
 *    Journal / Email insights / Portfolio / Spending, and the titles of
 *    this week's chats. The model may only write prompts about what the
 *    sheet says exists — the same grounding law the daily brief and stock
 *    profiles follow (nothing on the sheet, nothing in the output).
 *  - CloudPrivacy governs the sheet, class by class, NOT the call: a class
 *    that may not leave this Mac contributes nothing (not even a count),
 *    so the call itself never has to be refused. Task and project titles,
 *    calendar titles and chat titles are ungated (dated facts / text that
 *    already went to the brain). When the brain runs on this Mac the sheet
 *    is complete.
 *  - One short JSON call (`format: 'json'`, no thinking), tagged
 *    `prompt-suggestions` in LLM Logs / AI Activity like every ambient
 *    source. Output is validated (`parseReply`): 3–8 short strings, no
 *    duplicates, nothing that reads as a paragraph or a link.
 *  - MACHINE-LOCAL. localStorage `prompt-suggestions` — the sheet depends
 *    on this Mac's usage counts and brain, and a synced key re-stamped
 *    hourly would be exactly the volatile write the sync law forbids.
 *  - CADENCE: hourly, and only when the sheet CHANGED (hash) — a quiet Mac
 *    regenerates once a day at most. Metered brains (own key / Anjadhe
 *    Cloud) wait six hours between runs. A run is a resumable
 *    BackgroundWork source (a reload just asks again later).
 *  - SURFACES: AgentUI.generalSuggestions() prefers the current set over
 *    its static pool (the home composer row and the assistant's empty
 *    state both read it); page-specific AgentContext prompts still win on
 *    a page that has them. A finished run announces itself
 *    (`anjadhe:suggestions-changed`) and the two surfaces repaint.
 */
const PromptSuggestions = {
    SOURCE: 'prompt-suggestions',
    CACHE_KEY: 'prompt-suggestions',
    TTL_MS: 60 * 60 * 1000,
    METERED_TTL_MS: 6 * 60 * 60 * 1000,
    STALE_MS: 24 * 60 * 60 * 1000,
    CHECK_MS: 10 * 60 * 1000,
    MIN: 3,
    MAX: 8,
    MAX_LEN: 80,

    _cache: null,
    _inflight: null,
    _timer: null,

    /* ---------- pure core (Node-testable) ---------- */

    /**
     * The lines the model may cite. `inputs` is plain data (see _inputs).
     * Returns { text, hash } — hash is what decides "the sheet changed".
     */
    factSheet(inputs) {
        const i = inputs || {};
        const lines = [];
        const n = (v) => Number.isFinite(v) ? v : 0;
        const titles = (arr, max = 4) => (Array.isArray(arr) ? arr : [])
            .map(t => String(t || '').trim()).filter(Boolean).slice(0, max)
            .map(t => `"${t.length > 60 ? t.slice(0, 57) + '…' : t}"`).join(', ');

        lines.push(`Time: ${i.weekday || 'a weekday'} ${i.daypart || 'daytime'}${i.hour != null ? ` (${i.hour}:00)` : ''}.`);
        if (i.brain) lines.push(`AI model: ${i.brain}${i.brainLeaves ? ' (runs off this Mac)' : ' (runs on this Mac)'}.`);
        lines.push(`Web search: ${i.webOn ? 'on' : 'off'}. Writing voice: ${i.voiceOn ? 'studied' : 'not set up'}. Google (mail + calendar): ${i.googleMail ? 'connected' : 'not connected'}.`);
        if (Array.isArray(i.apps) && i.apps.length) lines.push(`Apps enabled: ${i.apps.join(', ')}.`);
        if (Array.isArray(i.frequent) && i.frequent.length) lines.push(`Opened most: ${i.frequent.join(', ')}.`);
        if (Array.isArray(i.setupPending) && i.setupPending.length) lines.push(`Setup not finished: ${i.setupPending.join('; ')}.`);

        const t = i.tasks;
        if (t) {
            const parts = [];
            if (n(t.overdue)) parts.push(`${t.overdue} overdue`);
            parts.push(`${n(t.today)} due today`);
            if (n(t.doneToday)) parts.push(`${t.doneToday} done today`);
            if (n(t.open)) parts.push(`${t.open} open in all`);
            let line = `Tasks: ${parts.join(', ')}.`;
            if (t.todayTitles && t.todayTitles.length) line += ` Today: ${titles(t.todayTitles)}.`;
            if (t.overdueTitles && t.overdueTitles.length) line += ` Overdue: ${titles(t.overdueTitles, 3)}.`;
            lines.push(line);
        } else lines.push('Tasks: none yet.');

        const g = i.goals;
        if (g && n(g.active)) {
            let line = `Projects: ${g.active} active`;
            if (g.titles && g.titles.length) line += ` — ${titles(g.titles)}`;
            if (g.dueSoon && g.dueSoon.length) line += `; target date within two weeks: ${titles(g.dueSoon, 2)}`;
            lines.push(line + '.');
        } else lines.push('Projects: none yet.');

        const c = i.calendar;
        if (c && (n(c.today) || n(c.tomorrow))) {
            let line = `Calendar: ${n(c.today)} event${c.today === 1 ? '' : 's'} today`;
            if (c.next && c.next.length) line += ` — ${titles(c.next, 3)}`;
            if (n(c.tomorrow)) line += `; ${c.tomorrow} tomorrow`;
            lines.push(line + '.');
        }

        const e = i.email;
        if (e) {
            if (n(e.unreadInsights)) lines.push(`Email insights waiting: ${e.unreadInsights}${e.folders && e.folders.length ? ` (${e.folders.join(', ')})` : ''}.`);
            else if (e.connected) lines.push('Email insights waiting: none.');
        }

        const no = i.notes;
        if (no && n(no.count)) {
            let line = `Notes: ${no.count}`;
            if (no.recent && no.recent.length) line += `; edited lately: ${titles(no.recent)}`;
            lines.push(line + '.');
        }
        if (n(i.routines)) lines.push(`Routines set up: ${i.routines}.`);
        if (n(i.documents)) lines.push(`Documents in the library: ${i.documents}.`);

        const j = i.journal;
        if (j && n(j.count)) lines.push(`Journal: ${j.count} entries; last one ${j.lastDaysAgo === 0 ? 'today' : j.lastDaysAgo === 1 ? 'yesterday' : j.lastDaysAgo != null ? `${j.lastDaysAgo} days ago` : 'a while ago'}.`);

        const p = i.portfolio;
        if (p && n(p.holdings)) {
            let line = `Portfolio: ${p.holdings} holdings`;
            if (p.top && p.top.length) line += ` (largest: ${p.top.join(', ')})`;
            if (typeof p.dayDirection === 'string') line += `; ${p.dayDirection} today`;
            if (p.watchlist) line += `; ${p.watchlist} on the watchlist`;
            lines.push(line + '.');
        }

        const s = i.spending;
        if (s && n(s.monthSpend)) {
            let line = `Spending this month: $${Math.round(s.monthSpend).toLocaleString('en-US')}`;
            if (s.topCategory) line += `, mostly ${s.topCategory}`;
            if (n(s.dueSoon)) line += `; ${s.dueSoon} recurring charge${s.dueSoon === 1 ? '' : 's'} due within ten days`;
            lines.push(line + '.');
        }

        if (Array.isArray(i.recentChats) && i.recentChats.length) lines.push(`Chats this week: ${titles(i.recentChats, 5)}.`);
        if (Array.isArray(i.shown) && i.shown.length) lines.push(`Already suggested last time (do not repeat): ${titles(i.shown, 8)}.`);

        const text = lines.join('\n');
        // The hash ignores the hour and the "already suggested" line: a sheet
        // that only aged is not a changed sheet, and last time's output must
        // not by itself force a new run.
        const stable = lines.filter(l => !/^Time:|^Already suggested/.test(l)).join('\n');
        return { text, hash: this.hash(stable) };
    },

    /** FNV-1a over the string — short, deterministic, good enough for "changed?". */
    hash(str) {
        let h = 0x811c9dc5;
        const s = String(str || '');
        for (let k = 0; k < s.length; k++) { h ^= s.charCodeAt(k); h = Math.imul(h, 0x01000193) >>> 0; }
        return h.toString(16).padStart(8, '0');
    },

    /**
     * The model's reply → the prompts we will show, or [] when the reply
     * is unusable. Accepts {"prompts":[…]}, a bare array, or one string
     * per line as a last resort. Every kept line is short, unique, and
     * reads like something typed into the composer.
     */
    parseReply(content) {
        const raw = String(content || '').trim();
        if (!raw) return [];
        let items = null;
        const tryParse = (s) => { try { return JSON.parse(s); } catch { return null; } };
        let v = tryParse(raw);
        if (v == null) {
            const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
            if (fence) v = tryParse(fence[1].trim());
        }
        if (v == null) {
            const a = raw.indexOf('['), b = raw.lastIndexOf(']');
            const o = raw.indexOf('{'), p = raw.lastIndexOf('}');
            if (o !== -1 && p > o) v = tryParse(raw.slice(o, p + 1));
            if (v == null && a !== -1 && b > a) v = tryParse(raw.slice(a, b + 1));
        }
        if (Array.isArray(v)) items = v;
        else if (v && typeof v === 'object') {
            const key = Object.keys(v).find(k => Array.isArray(v[k]));
            items = key ? v[key] : null;
        }
        if (!items) items = raw.split(/\r?\n/);

        const out = [];
        const seen = new Set();
        for (let it of items) {
            if (it && typeof it === 'object') it = it.text || it.prompt || it.ask || '';
            let s = String(it || '').trim()
                .replace(/^[-*•\d.)\s]+/, '')          // list markers
                .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '') // wrapping quotes
                .replace(/\s+/g, ' ')
                .replace(/\.$/, '')                       // a prompt, not a sentence
                .trim();
            if (!s) continue;
            if (s.length < 8 || s.length > this.MAX_LEN) continue;
            if (/https?:\/\/|www\./i.test(s)) continue;
            if (/^(prompts?|suggestions?|here are|sure|okay|ok)\b/i.test(s) && !/\?$/.test(s)) continue;
            if ((s.match(/[.!?]/g) || []).length > 1) continue; // a paragraph, not a prompt
            const key = s.toLowerCase().replace(/[^a-z0-9]+/g, '');
            if (!key || seen.has(key)) continue;
            seen.add(key);
            out.push(s);
            if (out.length >= this.MAX) break;
        }
        return out.length >= this.MIN ? out : [];
    },

    /**
     * Pick `n` of the current set for one surface. Hour-stable rotation,
     * offset per surface, so the home row and the assistant's empty state
     * show different members of the same set and both drift over the day.
     */
    pick(items, n, { offset = 0, now = Date.now() } = {}) {
        const list = Array.isArray(items) ? items.filter(Boolean) : [];
        if (!list.length) return [];
        const hour = Math.floor(now / 3600000);
        const start = (hour + offset) % list.length;
        const out = [];
        for (let k = 0; k < Math.min(n, list.length); k++) out.push(list[(start + k) % list.length]);
        return out;
    },

    /* ---------- state ---------- */

    cache() {
        if (this._cache) return this._cache;
        try { this._cache = JSON.parse(localStorage.getItem(this.CACHE_KEY) || 'null') || {}; }
        catch { this._cache = {}; }
        if (!Array.isArray(this._cache.items)) this._cache.items = [];
        return this._cache;
    },
    _save() { try { localStorage.setItem(this.CACHE_KEY, JSON.stringify(this.cache())); } catch { /* per-Mac cache */ } },

    /** The prompts to show right now: [] when none have been written yet. */
    current() {
        const c = this.cache();
        if (!c.items.length) return [];
        if (c.at && Date.now() - c.at > 7 * this.STALE_MS) return []; // a week old: back to the pool
        return c.items.slice();
    },

    /** When the current set was written (ms), or null. */
    writtenAt() { return this.cache().at || null; },

    available() {
        return typeof AgentService !== 'undefined' && !!AgentService.model
            && typeof LLMLogger !== 'undefined' && typeof LLMLogger.call === 'function';
    },

    _allows(cls) {
        try {
            if (typeof CloudPrivacy === 'undefined') return true;
            if (!CloudPrivacy.brainLeaves()) return true;
            return CloudPrivacy.allows(cls);
        } catch { return false; }
    },

    _numCtx() {
        try {
            const entry = AgentService.getDefaultEntry?.() || null;
            const n = AgentService.entryNumCtx ? AgentService.entryNumCtx(entry) : (AgentService.numCtx || 8192);
            return (Number.isFinite(n) && n > 0) ? n : 8192;
        } catch { return 8192; }
    },

    _ttl() {
        try { return AgentService.isMeteredBrain?.() ? this.METERED_TTL_MS : this.TTL_MS; }
        catch { return this.TTL_MS; }
    },

    /** Should a run happen now? Pure over (cache, sheet hash, now, ttl). */
    due(cache, hash, now, ttl, { force = false } = {}) {
        if (force) return true;
        const c = cache || {};
        const age = now - (c.at || 0);
        if (!c.items || !c.items.length) return !c.failedAt || now - c.failedAt > ttl;
        if (age < ttl) return false;
        if (c.hash !== hash) return true;
        return age >= this.STALE_MS;
    },

    /* ---------- the run ---------- */

    init() {
        if (this._timer) return;
        // Past first paint; the brain may still be warming, and ensureFresh
        // simply returns when there is none.
        setTimeout(() => { this.ensureFresh().catch(() => {}); }, 8000);
        this._timer = setInterval(() => { this.ensureFresh().catch(() => {}); }, this.CHECK_MS);
    },

    async ensureFresh({ force = false } = {}) {
        if (this._inflight) return this._inflight;
        if (!this.available()) return null;
        let inputs, sheet;
        try { inputs = this._inputs(); sheet = this.factSheet(inputs); }
        catch (e) { console.warn('[suggestions] fact sheet failed:', e?.message || e); return null; }
        if (!this.due(this.cache(), sheet.hash, Date.now(), this._ttl(), { force })) return null;
        const run = this._generate(sheet).finally(() => { this._inflight = null; });
        this._inflight = run;
        return run;
    },

    async _generate(sheet) {
        const params = {
            model: AgentService.model,
            format: 'json',
            maxTokens: 500,
            think: false,
            logTag: this.SOURCE,
            logDetail: 'Suggested prompts',
            messages: [
                { role: 'system', content: this._systemPrompt() },
                { role: 'user', content: `FACT SHEET (from the apps on this Mac, right now):\n${sheet.text}\n\nWrite the prompts.` }
            ],
            // Chat's own context size: a different num_ctx restarts the local
            // server, and a restart under an in-flight request is a hang-up
            // (seen on the first run: the warm-up's size vs the default).
            options: { temperature: 0.8, num_predict: 500, num_ctx: this._numCtx() }
        };
        let content = '';
        try {
            const res = await LLMLogger.call(this.SOURCE, params);
            if (res && res.error) throw new Error(String(res.error));
            content = res?.message?.content || res?.content || '';
        } catch (e) {
            const c = this.cache();
            c.failedAt = Date.now();
            c.error = String(e?.message || e).slice(0, 200);
            this._save();
            return null;
        }
        const items = this.parseReply(content);
        const c = this.cache();
        if (!items.length) {
            c.failedAt = Date.now();
            c.error = 'The model returned nothing usable.';
            this._save();
            return null;
        }
        c.items = items;
        c.at = Date.now();
        c.hash = sheet.hash;
        c.failedAt = null;
        c.error = null;
        try { c.model = AgentService.getDefaultEntry?.()?.label || AgentService.model; } catch { /* cosmetic */ }
        this._save();
        try { document.dispatchEvent(new CustomEvent('anjadhe:suggestions-changed', { detail: { items } })); } catch { /* no DOM */ }
        return items;
    },

    _systemPrompt() {
        return `You write the "Try asking…" suggestions inside Anjadhe, a private personal-assistant app on the user's Mac. The user sees them as buttons under the chat box and clicks one to send it.

Rules:
- Write 6 prompts, phrased exactly as the user would type them to their assistant (first person, direct: "What…", "Show me…", "Help me…", "Draft…").
- Every prompt must be about something the FACT SHEET says exists. Never invent a task, person, company, file or number that is not on the sheet. Quote a title from the sheet when it makes the prompt specific.
- Cover what matters now: the overdue and due-today work, a project or note the user is active in, the time of day (morning: plan the day; evening: review, journal), and ONE capability the user has not set up or rarely uses, only if the sheet lists it as enabled or not finished.
- The assistant can: read and summarise the user's tasks, projects, calendar, notes, journal, email insights, documents, portfolio and spending; create and reschedule tasks; draft notes, journal entries and emails; set up routines that run on a schedule; and look things up on the web ONLY if the sheet says "Web search: on" — when it says off, write nothing about the web, news, prices or looking things up.
- If the sheet says Google is not connected, write nothing about email or calendar except, at most, one prompt asking how to connect it.
- Each prompt under 60 characters, plain words, no emoji, no quotation marks around the whole prompt, no trailing period.
- Do not repeat anything listed under "Already suggested last time".
- Return ONLY JSON: {"prompts": ["…", "…"]}`;
    },

    /* ---------- inputs (renderer) ---------- */

    _inputs() {
        const now = new Date();
        const hour = now.getHours();
        const daypart = hour < 5 ? 'night' : hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : hour < 21 ? 'evening' : 'night';
        const weekday = now.toLocaleDateString('en-US', { weekday: 'long' });
        const out = { hour, daypart, weekday };

        try {
            const entry = AgentService.getDefaultEntry?.();
            out.brain = entry?.engine === 'anjadhe' && AgentService.anjadheEntryLabel ? AgentService.anjadheEntryLabel(entry) : (entry?.label || entry?.model || AgentService.model || null);
        } catch { out.brain = null; }
        try { out.brainLeaves = typeof CloudPrivacy !== 'undefined' && CloudPrivacy.brainLeaves(); } catch { out.brainLeaves = false; }
        try { out.webOn = !!(AgentService._webSearchReady); } catch { out.webOn = false; }
        try { out.voiceOn = typeof VoiceStore !== 'undefined' && VoiceStore.isOn(); } catch { out.voiceOn = false; }
        try { out.googleMail = ((StorageManager.get('accounts')?.accounts) || []).some(a => a.services?.mail); } catch { out.googleMail = false; }

        // Apps: what is on, and what the user actually opens (per-Mac counts).
        try {
            const label = (id) => (typeof AppManager !== 'undefined' && AppManager.appLabel) ? AppManager.appLabel(id) : id;
            const apps = (typeof GlobalSearch !== 'undefined' && GlobalSearch.launcherApps) ? GlobalSearch.launcherApps() : [];
            const hidden = (typeof AppManager !== 'undefined' && AppManager.getHiddenApps) ? AppManager.getHiddenApps() : new Set();
            out.apps = apps.filter(a => !hidden.has(a.id) && !['home', 'settings', 'agent', 'help', 'about'].includes(a.id)).map(a => label(a.id));
            const usage = AppManager.getAppUsage ? AppManager.getAppUsage() : {};
            out.frequent = (AppManager.getFrequentApps ? AppManager.getFrequentApps(5) : [])
                .filter(id => !['home', 'settings', 'agent'].includes(id))
                .map(id => `${label(id)} (${usage[id]?.count || 0}×)`);
        } catch { /* optional */ }

        try {
            if (typeof SetupAssistant !== 'undefined' && SetupAssistant.shouldShow && SetupAssistant.shouldShow()) {
                out.setupPending = SetupAssistant.steps().filter(s => !s.done).map(s => s.label || s.title || s.id).filter(Boolean).slice(0, 4);
            }
        } catch { /* optional */ }

        // Tasks + projects: dated facts, ungated.
        try {
            if (typeof ScheduleApp !== 'undefined' && ScheduleApp.getGroupedItems) {
                ScheduleApp.loadData?.();
                const g = ScheduleApp.getGroupedItems({ applySidebarFilter: false, applySearch: false });
                const all = ScheduleApp.scheduleItems || [];
                out.tasks = {
                    overdue: (g.overdue || []).length,
                    today: (g.todayActive || []).length,
                    doneToday: (g.todayCompleted || []).length,
                    open: all.length,
                    todayTitles: (g.todayActive || []).map(i => i.title),
                    overdueTitles: (g.overdue || []).map(i => i.title)
                };
            } else {
                const items = StorageManager.get('schedule')?.scheduleItems || [];
                if (items.length) out.tasks = { open: items.length, today: 0, overdue: 0 };
            }
        } catch { /* optional */ }
        try {
            const goals = (StorageManager.get('goals')?.goals || []).filter(g => g.status !== 'completed' && g.status !== 'draft');
            if (goals.length) {
                const soon = Date.now() + 14 * 86400000;
                out.goals = {
                    active: goals.length,
                    titles: goals.slice(0, 4).map(g => g.title),
                    dueSoon: goals.filter(g => g.targetDate && Date.parse(g.targetDate) <= soon && Date.parse(g.targetDate) >= Date.now() - 86400000).map(g => g.title)
                };
            }
        } catch { /* optional */ }
        try {
            if (typeof CalendarApp !== 'undefined' && Array.isArray(CalendarApp.events) && CalendarApp.events.length) {
                const day = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
                const today = day(now);
                const tmr = new Date(now); tmr.setDate(tmr.getDate() + 1);
                const tomorrow = day(tmr);
                const on = (d) => CalendarApp.events.filter(e => String(e.start || e.date || '').slice(0, 10) === d);
                const t = on(today).sort((a, b) => String(a.start || '').localeCompare(String(b.start || '')));
                out.calendar = { today: t.length, tomorrow: on(tomorrow).length, next: t.filter(e => !e.start || Date.parse(e.start) >= now.getTime() - 3600000).map(e => e.title || e.summary) };
            }
        } catch { /* optional */ }

        // Email: the count is ungated; folder names ride the email class.
        try {
            if (typeof EmailApp !== 'undefined' && EmailApp.getProfileAnalyses) {
                const analyses = EmailApp.getProfileAnalyses() || {};
                const unread = Object.values(analyses).filter(a => a && !a.readAt && !a.rolledUp);
                const folders = this._allows('email') ? [...new Set(unread.map(a => a.type).filter(Boolean))].slice(0, 4) : [];
                out.email = { connected: !!out.googleMail, unreadInsights: unread.length, folders };
            }
        } catch { /* optional */ }

        try {
            const notes = (StorageManager.get('notes')?.notes || []);
            const plain = notes.filter(n => n && n.template !== 'prompt');
            out.routines = notes.filter(n => n && n.template === 'prompt').length;
            if (plain.length && this._allows('notes')) {
                out.notes = {
                    count: plain.length,
                    recent: plain.slice().sort((a, b) => String(b.modifiedAt || '').localeCompare(String(a.modifiedAt || ''))).slice(0, 4).map(n => n.title)
                };
            }
        } catch { /* optional */ }
        try {
            const entries = (StorageManager.get('journal')?.entries || []).filter(Boolean);
            if (entries.length && this._allows('journal')) {
                const last = entries.map(e => Date.parse(e.date || e.createdAt || 0)).filter(Number.isFinite).sort((a, b) => b - a)[0];
                out.journal = { count: entries.length, lastDaysAgo: last ? Math.max(0, Math.floor((Date.now() - last) / 86400000)) : null };
            }
        } catch { /* optional */ }
        try {
            const docs = StorageManager.get('library')?.docs || StorageManager.get('library')?.documents;
            if (Array.isArray(docs)) out.documents = docs.length;
        } catch { /* optional */ }

        try {
            if (typeof PortfolioApp !== 'undefined' && PortfolioApp.computeHoldings && this._allows('portfolio')) {
                PortfolioApp.loadData?.();
                const holdings = (PortfolioApp.computeHoldings() || []).filter(h => h.currentValue > 0);
                if (holdings.length) {
                    const summary = PortfolioApp.getSummary ? PortfolioApp.getSummary(holdings) : null;
                    const top = holdings.slice().sort((a, b) => b.currentValue - a.currentValue).slice(0, 3).map(h => h.label || h.ticker);
                    const dir = summary && Number.isFinite(summary.totalDayChange) && summary.totalDayChange !== 0 ? (summary.totalDayChange > 0 ? 'up' : 'down') : undefined;
                    out.portfolio = { holdings: holdings.length, top, dayDirection: dir, watchlist: (PortfolioApp.data?.watchlist || []).length || 0 };
                }
            }
        } catch { /* optional */ }
        try {
            if (typeof SpendingApp !== 'undefined' && SpendingApp.summary && this._allows('spending')) {
                SpendingApp.loadData?.();
                if (SpendingApp.transactions?.().length) {
                    const month = SpendingApp.monthKey(SpendingApp.today());
                    const s = SpendingApp.summary(month);
                    const due = SpendingApp.recurring ? (SpendingApp.recurring(SpendingApp.transactions()) || []).filter(r => r.next && Date.parse(r.next) - Date.now() < 10 * 86400000).length : 0;
                    out.spending = { monthSpend: s.spend, topCategory: s.byCategory?.[0]?.label, dueSoon: due };
                }
            }
        } catch { /* optional */ }

        // What the user talked about this week: titles only, already seen by the brain.
        try {
            const weekAgo = Date.now() - 7 * 86400000;
            out.recentChats = (AgentService.conversations || [])
                .filter(c => c && c.title && c.title !== 'New chat' && Date.parse(c.updatedAt || 0) >= weekAgo && (c.messages || []).length)
                .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
                .slice(0, 5).map(c => c.title);
        } catch { /* optional */ }

        out.shown = this.cache().items.slice(0, 8);
        return out;
    },

    /** BackgroundWork descriptor: null when idle. */
    writing() { return this._inflight ? { current: 'Suggested prompts' } : null; }
};

if (typeof module !== 'undefined' && module.exports) module.exports = PromptSuggestions;
