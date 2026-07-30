/**
 * GlobalSearch — one ranked search over apps and personal data.
 *
 * This is what lets the app list leave the nav. An always-visible icon strip
 * is a browsing affordance for a suite; a search box is the affordance for a
 * system with a lot behind it. Take away the strip without giving people a
 * way to type "notes" and you have only made things harder to find.
 *
 * Two result kinds, and they are deliberately different:
 *
 *   apps   — every registered app, matched on name. Empty query returns them
 *            all, so ⌘K with nothing typed IS the app list.
 *   items  — goals, notes, journal, tasks, bookmarks, wellness, focus areas.
 *            Never returned for an empty query; there is no useful "all your
 *            data" list.
 *
 * The agent's `search_all` tool delegates here (see AgentTools.search_all) so
 * there is one search implementation rather than two that drift. That tool's
 * result shape is load-bearing, so `data()` keeps every per-app extra field
 * it used to return.
 *
 * Ranking, highest first: exact title, title prefix, title word-start, title
 * substring, body substring. Multi-word queries are AND — every term must
 * land somewhere in the record.
 */
const GlobalSearch = {
    SCORE: { EXACT: 100, PREFIX: 80, WORD: 70, TITLE: 60, BODY: 30 },

    _terms(query) {
        return String(query || '').toLowerCase().trim().split(/\s+/).filter(Boolean);
    },

    /**
     * Score one term against a record. Returns 0 when the term is absent,
     * which is what makes the AND across terms work.
     */
    _scoreTerm(term, title, body) {
        const t = (title || '').toLowerCase();
        if (t === term) return this.SCORE.EXACT;
        if (t.startsWith(term)) return this.SCORE.PREFIX;
        // Word-start inside the title: "car" should rank "Renew car
        // registration" above a note that merely mentions cars in its body.
        if (new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(t)) return this.SCORE.WORD;
        if (t.includes(term)) return this.SCORE.TITLE;
        if ((body || '').toLowerCase().includes(term)) return this.SCORE.BODY;
        return 0;
    },

    /** Total score, or 0 if any term is missing (AND semantics). */
    _score(terms, title, body) {
        let total = 0;
        for (const term of terms) {
            const s = this._scoreTerm(term, title, body);
            if (!s) return 0;
            total += s;
        }
        return total;
    },

    // ── Apps ──

    /**
     * Every app, read from the nav tiles rather than a hardcoded list — so
     * user-built apps (AppManager._addUserAppTile) and any future built-in
     * appear here automatically, icon included.
     */
    allApps() {
        // The grid lives in the All apps sheet since 2026-07-29; the
        // favourites row inside it duplicates tiles, which `seen` drops.
        const tiles = document.querySelectorAll('.dash-apps-section .dash-app-tile[data-app]');
        const seen = new Set();
        const out = [];
        for (const tile of tiles) {
            const id = tile.dataset.app;
            if (!id || seen.has(id)) continue;      // favourites row duplicates tiles
            seen.add(id);
            out.push({
                id,
                title: tile.querySelector('.dash-app-tile-label')?.textContent.trim() || id,
                icon: tile.querySelector('.dash-app-tile-icon')?.innerHTML || '',
                group: tile.closest('.dash-apps-group')?.querySelector('.dash-apps-group-label')?.textContent.trim() || ''
            });
        }
        return out;
    },

    /** Most-used first. Hidden apps are excluded — see apps(). */
    frequentApps() {
        if (typeof AppManager?.getFrequentApps !== 'function') return [];
        const hidden = AppManager.getHiddenApps?.() || new Set();
        const byId = new Map(this.allApps().map(a => [a.id, a]));
        return AppManager.getFrequentApps()
            .filter(id => !hidden.has(id) && byId.has(id))
            .map(id => byId.get(id));
    },

    apps(query) {
        const terms = this._terms(query);
        const hidden = (typeof AppManager?.getHiddenApps === 'function')
            ? AppManager.getHiddenApps() : new Set();

        // Hiding an app is about decluttering home, not disabling it — so a
        // hidden app stays findable by name, it just does not pad the
        // empty-query list.
        if (!terms.length) return this.allApps().filter(a => !hidden.has(a.id));

        // Usage breaks ties only — it never outranks a better text match.
        // A boost added to the score would let a heavily-used app with a
        // mid-word hit jump a clean prefix match, which makes typing feel
        // unpredictable; ordering within an equal score does not.
        const frequent = (typeof AppManager?.getFrequentApps === 'function')
            ? AppManager.getFrequentApps(Infinity) : [];
        const rank = (id) => {
            const i = frequent.indexOf(id);
            return i === -1 ? Number.MAX_SAFE_INTEGER : i;
        };

        return this.allApps()
            .map(a => ({ ...a, score: this._score(terms, a.title, a.id) }))
            .filter(a => a.score > 0)
            .sort((a, b) => b.score - a.score
                || rank(a.id) - rank(b.id)
                || a.title.localeCompare(b.title));
    },

    // ── Personal data ──

    /**
     * Ranked records across every searchable app.
     *
     * Each entry carries `app`, `id`, `title`, an optional `snippet`, and a
     * `meta` object holding the app-specific fields `search_all` has always
     * returned (targetDate, kind, time…). Callers that need the old flat
     * shape spread `meta` back in.
     */
    data(query, limit = 20) {
        const terms = this._terms(query);
        if (!terms.length) return [];

        const get = (key, field) => {
            const d = StorageManager.get(key);
            return Array.isArray(d?.[field]) ? d[field] : [];
        };

        const hits = [];
        const push = (app, id, title, body, extra) => {
            const score = this._score(terms, title, body);
            if (score > 0) hits.push({ app, id, title: title || '(untitled)', score, ...extra });
        };

        for (const g of get('goals', 'goals')) {
            push('goals', g.id, g.title, g.description,
                { meta: { targetDate: g.targetDate || null } });
        }

        for (const n of get('notes', 'notes')) {
            // Notes are rich text; _noteText strips markup so the body match
            // isn't fooled by tag names and the snippet is readable.
            const text = (typeof AgentTools !== 'undefined' && AgentTools._noteText)
                ? AgentTools._noteText(n) : String(n.content || '');
            push('notes', n.id, n.title, text,
                { snippet: text.slice(0, 120), meta: { snippet: text.slice(0, 120) } });
        }

        for (const e of get('journal', 'entries')) {
            push('journal', e.id, e.title || e.date, e.content,
                { snippet: String(e.content || '').replace(/<[^>]*>/g, '').slice(0, 120), meta: {} });
        }

        for (const s of get('schedule', 'scheduleItems')) {
            push('schedule', s.id, s.title, null,
                { meta: {}, sub: s.scheduledDate || null });
        }

        for (const b of get('bookmarks', 'bookmarks')) {
            push('bookmarks', b.id, b.title, `${b.url || ''} ${b.description || ''}`,
                { sub: b.url || '', meta: {} });
        }

        for (const f of get('focus', 'focusItems')) {
            push('focus', f.id, f.title, f.description, { meta: {} });
        }

        // Wellness is deliberately NOT profile-filtered — the health log is
        // profile-agnostic by design (see js/apps/wellness/).
        for (const w of get('wellness', 'entries')) {
            const text = [w.name, w.description, w.notes, w.activityType, w.mealType]
                .filter(Boolean).join(' ');
            const label = `${w.kind}: ${(w.name || w.description || w.notes || w.activityType || '').slice(0, 60)}`;
            push('wellness', w.id, label, text, { meta: { kind: w.kind, time: w.time } });
        }

        return hits.sort((a, b) => b.score - a.score).slice(0, limit);
    },

    search(query, limit = 8) {
        const typing = this._terms(query).length > 0;
        // An empty query returns EVERY app — ⌘K with nothing typed is the
        // app list, so capping it there would quietly hide half the suite.
        // Once the user is typing, a short ranked list is the right answer.
        const appLimit = typing ? limit : Infinity;

        // The apps you use most lead the empty query. They are pulled OUT of
        // the apps list rather than repeated above it: the same app twice in
        // one keyboard list is a nuisance to arrow through, and every app is
        // still shown exactly once across the two groups.
        const frequent = typing ? [] : this.frequentApps();
        const frequentIds = new Set(frequent.map(a => a.id));

        return {
            frequent,
            apps: this.apps(query).filter(a => !frequentIds.has(a.id)).slice(0, appLimit),
            items: this.data(query, limit)
        };
    },

    /**
     * Open a result. Record-level deep links reuse LinkPicker.navigateToItem,
     * which already knows every app's editor entry point; the cases it does
     * not cover fall back to opening the app itself.
     */
    open(hit) {
        if (!hit) return;
        if (hit.kind === 'app') { AppManager.openApp(hit.id); return; }

        switch (hit.app) {
            case 'journal':
                AppManager.openApp('journal');
                setTimeout(() => JournalApp.openViewer?.(hit.id), 0);
                return;
            case 'wellness':
                // No per-entry page exists; the log itself is the destination.
                AppManager.openApp('wellness');
                return;
            default:
                if (typeof LinkPicker?.navigateToItem === 'function') {
                    LinkPicker.navigateToItem(hit.app, hit.id);
                } else {
                    AppManager.openApp(hit.app);
                }
        }
    },

    /** Human label for the app badge on a result row. */
    appLabel(app) {
        const map = {
            goals: 'Goal', notes: 'Note', journal: 'Journal', schedule: 'Task',
            bookmarks: 'Bookmark', focus: 'Focus area', wellness: 'Wellness'
        };
        return map[app] || app;
    }
};
