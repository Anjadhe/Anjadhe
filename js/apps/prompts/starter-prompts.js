/**
 * StarterPrompts — out-of-the-box prompt notes seeded once per install.
 *
 * A fresh install gets a small set of ready-made routines (Daily
 * Briefing, News Digest, Daily Motivation, Weekly Reflection, plus any an
 * app package registers — Portfolio's Market Review) so the home feed demonstrates itself without the user authoring
 * anything. They are ordinary prompt notes — editable, reschedulable,
 * deletable.
 *
 * Idempotency: ids are fixed (so any sync-convergence path collapses to one
 * copy) and a synced `starter-prompts` flag key records WHICH ids have been
 * seeded (per-id since 2026-07-30, so starters added in updates reach
 * existing installs) — a Mac that merges the flag never re-seeds those ids,
 * and deleting a starter never resurrects it.
 *
 * All except the Daily Briefing get their `promptFeed.runs` stamp
 * pre-filled at seed time, anchoring them to their scheduled times instead
 * of all firing on the first scheduler pass. The briefing is left unstamped
 * on purpose: one immediate post (once a model is ready) shows what the
 * feed is for.
 */
const StarterPrompts = {
    KEY: 'starter-prompts',

    ITEMS: [
        {
            id: 'starter-daily-briefing',
            title: 'Daily Briefing',
            config: { offline: true, interval: 'daily', time: '08:00', web: false, useContext: true },
            runImmediately: true,
            // The blank-slate branch is what the immediate first run shows a
            // brand-new install (2026-08-06): without it, day one was a
            // rundown of "Nothing due / Nothing overdue / No goals" ending in
            // a platitude — a list of nothings demonstrating nothing.
            body: 'Write my morning briefing. Look at my tasks, projects, and calendar: list what is due or scheduled today (with times where known), call out anything overdue I should clear or reschedule, and note what is coming up tomorrow. Keep it short and scannable — a few bullets — and end with the single thing that matters most today. Special case: if there are no tasks, no projects, and no events at all — a brand-new workspace — do NOT write a rundown of empty sections. Instead write a short welcome: say this briefing will land here each morning, one line on what it covers once tasks, projects, email, or calendar are in, and one concrete first step (add a task, set up a project, or connect Gmail or Google Calendar in Settings). Warm, brief, no filler advice.'
        },
        // Morning News: registered by the News package (js/apps/news/news-tools.js).
        {
            id: 'starter-daily-motivation',
            title: 'Daily Motivation',
            config: { offline: true, interval: 'daily', time: '09:00', web: false, useContext: true },
            body: 'Write a short piece of daily motivation that is actually about me. Look at my open tasks and projects — especially anything overdue or quiet for a while — and write a few encouraging lines that acknowledge what I am working through, then give one concrete, doable suggestion for today. Vary the style day to day: sometimes a fitting quote, sometimes a reframe, sometimes a tiny challenge. Never generic filler. If I have no tasks and no projects yet, there is nothing to be motivated about: write one quiet line inviting me to set up a first project, and stop.'
        },
        {
            id: 'starter-weekly-reflection',
            title: 'Weekly Reflection',
            config: { offline: true, interval: 'weekly', time: '18:00', web: false, useContext: true },
            body: 'Help me reflect on my week. Review my tasks, projects, and journal: what got completed, what slipped or kept getting pushed, and which projects moved forward or stalled. Write a short, honest reflection — wins first, then patterns worth noticing — and end with three specific questions worth thinking about for next week. If there is nothing at all to reflect on — no tasks, projects, or journal entries this week — say so in one quiet line and stop.'
        },
        // App packages add their own (StarterPrompts.register) — Portfolio's
        // Market Review lives in js/apps/portfolio/portfolio-tools.js.
    ],

    // Starters withdrawn from the set (2026-08-04): the three market
    // reviews above, replaced by the single timezone-aware one. seed()
    // removes an install's existing copies ONLY when they are untouched —
    // same title, body and schedule the seeder wrote — so an edited or
    // rescheduled copy is the user's routine now and stays. Removal goes
    // through NotePrompts.remove (tombstoned), so it survives the notes
    // record merge instead of resurrecting from another Mac; an edit newer
    // than the tombstone beats the delete by design. Their `runs` stamps
    // are left behind on purpose — the runs merge is union-newest, so a
    // local delete would just resurrect, and an orphan stamp is inert.
    RETIRED: [
        // Packages retire their own (StarterPrompts.retire) — the three
        // market reviews the single Market Review replaced are Portfolio's.
    ],

    /** An app package's starter routine: same shape as ITEMS entries. Must
     *  be called before AppManager.init reaches seed() — bundled packages
     *  load first, so registering at script load is in time. */
    register(item) {
        if (!item || !item.id || !item.title || !item.body) return false;
        if (!this.ITEMS.some(it => it.id === item.id)) this.ITEMS.push(item);
        return true;
    },

    /** A starter a package withdrew: { id, title, interval, time, body } —
     *  removed from an install only while untouched (see _retireOldStarters). */
    retire(item) {
        if (!item || !item.id) return false;
        if (!this.RETIRED.some(it => it.id === item.id)) this.RETIRED.push(item);
        return true;
    },

    MARKET_TZ: 'America/New_York',

    // Local HH:MM for an ET wall-clock time, computed against today's
    // offsets (so DST on either side is current at seed time). The routine
    // stores a plain local time from then on — if the user's zone and New
    // York shift on different dates it can drift an hour for a week or two
    // a year, which editing the routine fixes; not worth a live-TZ field on
    // every routine. Falls back to the ET literal if Intl throws.
    _marketTimeLocal(etTime) {
        try {
            const [h, m] = etTime.split(':').map(Number);
            const now = new Date();
            // ET wall time re-parsed as if local: the difference to `now`
            // is (local offset − ET offset), to the minute.
            const etNow = new Date(now.toLocaleString('en-US', { timeZone: this.MARKET_TZ }));
            const diffMin = Math.round((now - etNow) / 60000);
            const local = ((h * 60 + m + diffMin) % 1440 + 1440) % 1440;
            return `${String(Math.floor(local / 60)).padStart(2, '0')}:${String(local % 60).padStart(2, '0')}`;
        } catch (_) {
            return etTime;
        }
    },

    // Delete retired starters this install still carries untouched. Runs
    // every boot (three id lookups, idempotent): missing → no-op, edited →
    // skipped forever, present-and-pristine → removed once with a
    // tombstone. A fresh install never had them, so this is a no-op there.
    _retireOldStarters() {
        for (const it of this.RETIRED) {
            const note = NotePrompts._readNotes().find(n => n && n.id === it.id);
            if (!note) continue;
            const cfg = note.prompt || {};
            const untouched = note.title === it.title
                && note.content === NotePrompts._bodyToHtml(it.body)
                && cfg.interval === it.interval
                && cfg.time === it.time;
            if (untouched) NotePrompts.remove(it.id);
        }
    },

    seed() {
        if (typeof NotePrompts === 'undefined' || typeof StorageManager === 'undefined') return;

        this._retireOldStarters();

        // Per-id diff (was a one-shot flag until 2026-07-30): each starter id
        // seeds exactly once per install, so starters added in an update
        // reach existing installs too. The flag only ever grows — "deleting a
        // starter never resurrects it" still holds per id, and a stale flag
        // merging in from a not-yet-updated Mac just re-runs the diff against
        // the notes-id guard below, which makes it a no-op.
        const seeded = new Set(StorageManager.get(this.KEY)?.ids || []);
        const toSeed = this.ITEMS.filter(it => !seeded.has(it.id));
        if (!toSeed.length) return;

        const notes = NotePrompts._readNotes();
        const existing = new Set(notes.map(n => n.id));
        const now = new Date().toISOString();
        const fresh = toSeed.filter(it => !existing.has(it.id)).map(it => ({
            id: it.id,
            title: it.title,
            content: NotePrompts._bodyToHtml(it.body),
            tags: [],
            template: 'prompt',
            prompt: {
                ...NotePrompts.DEFAULTS,
                ...it.config,
                ...(it.marketTime ? { time: this._marketTimeLocal(it.marketTime) } : {})
            },
            pinned: false,
            createdAt: now,
            modifiedAt: now
        }));
        if (fresh.length) NotePrompts._writeNotes([...fresh, ...notes]);

        // Anchor every newly seeded starter except run-immediately ones to
        // their scheduled time — otherwise the first scheduler pass would
        // fire them all at once (or, on an upgrade, the moment the app
        // boots). Already-seeded ids keep whatever stamp they have.
        const feed = StorageManager.get('promptFeed') || {};
        const runs = (feed.runs && typeof feed.runs === 'object') ? feed.runs : {};
        for (const it of toSeed) {
            if (!it.runImmediately && !runs[it.id]) runs[it.id] = now;
        }
        StorageManager.set('promptFeed', { items: Array.isArray(feed.items) ? feed.items : [], runs });

        StorageManager.set(this.KEY, { ids: [...seeded, ...toSeed.map(it => it.id)] });
    }
};
