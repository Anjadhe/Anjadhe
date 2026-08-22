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
 *   items  — goals, notes, journal, tasks, bookmarks, wellness,
 *            portfolio accounts and properties. Never returned for an empty
 *            query; there is no useful "all your data" list.
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
            // A feature-gated-off app (Maker behind its experimental flag) is
            // NOT the hidden-app bargain: hiding declutters and the app stays
            // findable by name, but a gated slug is refused by openApp, so a
            // ⌘K hit would be a dead row. Dropping it here covers every
            // reader at once — by-name search, the empty-query list, and any
            // launcher built off this registry.
            if (tile.dataset.feature && typeof FEATURES !== 'undefined'
                && !FEATURES.isEnabled(tile.dataset.feature)) continue;
            seen.add(id);
            out.push({
                id,
                title: tile.querySelector('.dash-app-tile-label')?.textContent.trim() || id,
                icon: tile.querySelector('.dash-app-tile-icon')?.innerHTML || '',
                group: tile.closest('.dash-apps-group')?.querySelector('.dash-apps-group-label')?.textContent.trim() || '',
                // Set when this app is reached THROUGH another one rather
                // than from a launcher (Inbox, via Email AI). Names the door,
                // so the reason travels with the flag. See launcherApps().
                subappOf: tile.dataset.subappOf || null,
                // One-line card copy for the More apps page.
                desc: tile.dataset.desc || '',
            });
        }
        return out;
    },

    /**
     * Every app that belongs in a LAUNCHER — the app-switcher grid, ⌘K's
     * empty-query list, the Customize-home-apps page.
     *
     * A sub-app is left out: it has one door, inside its parent, and
     * offering a second one in the switcher says the two are peers when
     * they are not. allApps() still returns it, because the registry is
     * also what the badge, the App Lock picker and ⌘K's by-name search read
     * — this is a launcher rule, not a removal.
     */
    launcherApps() {
        return this.allApps().filter(a => !a.subappOf);
    },

    /** Most-used first. Hidden and sub-apps are excluded — see apps(). */
    frequentApps() {
        if (typeof AppManager?.getFrequentApps !== 'function') return [];
        const hidden = AppManager.getHiddenApps?.() || new Set();
        const byId = new Map(this.launcherApps().map(a => [a.id, a]));
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
        // empty-query list. A sub-app (Inbox) is the same bargain made in
        // code rather than by the user: out of every launcher list, still
        // reachable by typing its name, so ⌘K stays the thing that can
        // always get you anywhere.
        if (!terms.length) return this.launcherApps().filter(a => !hidden.has(a.id));

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
            // Routines and their feed posts are notes under the hood. Label
            // them, or a hit titled "Portfolio Watch" reads like a personal
            // note about the portfolio when it is a routine's prompt text or
            // machine-written output — exactly the confusion that sent the
            // agent updating notes instead of the account.
            const tpl = (typeof NoteTemplates !== 'undefined') ? NoteTemplates.resolve(n) : n.template;
            const kind = tpl === 'feed' ? 'routine result'
                : tpl === 'prompt' ? ((n.prompt && n.prompt.offline) ? 'routine' : 'saved prompt')
                : null;
            push('notes', n.id, n.title, text,
                { snippet: text.slice(0, 120),
                  meta: { snippet: text.slice(0, 120), ...(kind ? { kind } : {}) } });
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

        // Wellness is deliberately NOT profile-filtered — the health log is
        // profile-agnostic by design (see js/apps/wellness/).
        for (const w of get('wellness', 'entries')) {
            const text = [w.name, w.description, w.notes, w.activityType, w.mealType]
                .filter(Boolean).join(' ');
            const label = `${w.kind}: ${(w.name || w.description || w.notes || w.activityType || '').slice(0, 60)}`;
            push('wellness', w.id, label, text, { meta: { kind: w.kind, time: w.time } });
        }

        // Portfolio accounts and properties — "padma robinhood" must find
        // the account record itself, not a note that merely mentions it.
        // Holdings are derived, not records, so they are not indexed; the
        // account is what the user names in "update X with this trade".
        const pf = StorageManager.get('portfolio') || {};
        for (const a of (Array.isArray(pf.accounts) ? pf.accounts : [])) {
            push('portfolio', a.id, a.name, `${a.type || ''} ${a.institution || ''} ${a.notes || ''}`,
                { sub: a.type || '', meta: { kind: 'account', type: a.type || null } });
        }
        for (const p of (Array.isArray(pf.properties) ? pf.properties : [])) {
            push('portfolio', p.id, p.name || p.address || 'Property', p.address || '',
                { sub: 'Property', meta: { kind: 'property' } });
        }

        return hits.sort((a, b) => b.score - a.score).slice(0, limit);
    },

    // ── Settings ──

    /**
     * Ranked settings entries, read from the Settings panels' cards (their
     * titles + the data-keywords each card already carries for the in-page
     * settings search) — so the two searches can't drift. Only returned while
     * typing; hits open the containing category page.
     */
    settings(query, limit = 3) {
        const terms = this._terms(query);
        if (!terms.length) return [];
        const hits = [];
        document.querySelectorAll('#settings-detail .settings-panel').forEach(panel => {
            const cat = panel.dataset.cat;
            // Same rule as Settings' own search: finished setup stays buried.
            if (cat === 'setup' && typeof SetupAssistant !== 'undefined'
                && SetupAssistant.isComplete()) return;
            const panelTitle = panel.querySelector('.settings-panel-title')?.textContent.trim() || 'Settings';
            panel.querySelectorAll('.settings-card').forEach(card => {
                // Feature-gated-off cards would open onto a page without them.
                const gate = card.closest('[data-feature]');
                if (gate && typeof FEATURES !== 'undefined'
                    && !FEATURES.isEnabled(gate.getAttribute('data-feature'))) return;
                // Same for conditionally hidden sections (Touch ID on a Mac
                // without it, finished setup): a hit would land on a page
                // where the card isn't there.
                if (card.closest('[style*="display: none"], [style*="display:none"]')) return;
                const titleEl = card.querySelector('.settings-card-title');
                let title, sub = panelTitle;
                if (titleEl) {
                    const clean = titleEl.cloneNode(true);
                    clean.querySelectorAll('.settings-badge').forEach(b => b.remove());
                    title = clean.textContent.trim();
                } else {
                    // A card with no title of its own — the Send Feedback
                    // form IS its whole panel — searches under the panel's
                    // name. The in-page settings search already matches
                    // these by their keywords; ⌘K skipping them meant
                    // "feedback" found nothing.
                    title = panelTitle;
                    sub = 'Settings';
                }
                if (!title) return;
                const body = `${card.textContent} ${card.dataset.keywords || ''} ${panelTitle}`;
                const score = this._score(terms, title, body);
                if (score > 0) hits.push({ kind: 'setting', cat, id: cat, title, sub, score });
            });
        });
        // Several title-less cards in one panel would all carry the panel's
        // name — one entry per (category, title) is enough, best score wins.
        const seen = new Map();
        for (const h of hits.sort((a, b) => b.score - a.score)) {
            const k = `${h.cat}|${h.title}`;
            if (!seen.has(k)) seen.set(k, h);
        }
        return [...seen.values()].slice(0, limit);
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
            items: this.data(query, limit),
            // A short tail of settings hits — "dark mode" or "passcode" in ⌘K
            // should land in Settings without knowing where it lives.
            settings: typing ? this.settings(query) : []
        };
    },

    /**
     * Open a result. Record-level deep links reuse
     * LinkedItemsUI.navigateToItem (js/components/link-picker.js — the
     * second object in that file, NOT LinkPicker), which already knows
     * every app's editor entry point; the cases it does not cover fall
     * back to opening the app itself.
     */
    open(hit) {
        if (!hit) return;
        if (hit.kind === 'app') { AppManager.openApp(hit.id); return; }
        if (hit.kind === 'setting') {
            AppManager.openApp('settings');
            // Let the settings render settle before drilling into the page.
            setTimeout(() => SettingsApp.openCategory?.(hit.cat), 0);
            return;
        }

        switch (hit.app) {
            case 'journal':
                AppManager.openApp('journal');
                setTimeout(() => JournalApp.openViewer?.(hit.id), 0);
                return;
            case 'wellness':
                // No per-entry page exists; the log itself is the destination.
                AppManager.openApp('wellness');
                return;
            case 'portfolio':
                // Properties have no per-record page; accounts deep-link via
                // navigateToItem's portfolio case (openAccountDetail).
                if (hit.meta?.kind === 'property') {
                    AppManager.openApp('portfolio');
                    return;
                }
                // eslint-disable-next-line no-fallthrough
            default:
                if (typeof LinkedItemsUI?.navigateToItem === 'function') {
                    LinkedItemsUI.navigateToItem(hit.app, hit.id);
                } else {
                    AppManager.openApp(hit.app);
                }
        }
    },

    /** Human label for the app badge on a result row. */
    appLabel(app) {
        const map = {
            goals: 'Goal', notes: 'Note', journal: 'Journal', schedule: 'Task',
            bookmarks: 'Bookmark', wellness: 'Wellness',
            portfolio: 'Portfolio'
        };
        return map[app] || app;
    }
};
