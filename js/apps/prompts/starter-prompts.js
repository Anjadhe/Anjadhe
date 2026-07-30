/**
 * StarterPrompts — out-of-the-box prompt notes seeded once per install.
 *
 * A fresh install gets a small set of ready-made background prompts (Daily
 * Briefing, News Digest, Daily Motivation, Weekly Reflection) so the home
 * feed demonstrates itself without the user authoring anything. They are
 * ordinary prompt notes — editable, reschedulable, deletable.
 *
 * Idempotency: ids are fixed (so any sync-convergence path collapses to one
 * copy) and a synced `starter-prompts` flag key records that seeding
 * happened — a Mac that merges the flag never re-seeds, and deleting a
 * starter never resurrects it.
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
            body: 'Write my morning briefing. Look at my tasks, goals, and calendar: list what is due or scheduled today (with times where known), call out anything overdue I should clear or reschedule, and note what is coming up tomorrow. Keep it short and scannable — a few bullets — and end with the single thing that matters most today.'
        },
        {
            id: 'starter-news-digest',
            title: 'Morning News',
            // Moved from 17:00 to the morning on 2026-07-29, when the home
            // Discover pane was removed: the feed post is now the thing that
            // greets you with the news, so it should be there before the day
            // starts rather than at the end of it. Seeding is one-shot, so
            // installs that already have this prompt keep their 17:00 time
            // until the user edits it in Manage prompts.
            config: { offline: true, interval: 'daily', time: '07:00', web: true, useContext: false },
            // Reads the user's OWN topics via get_news rather than searching
            // the web: the headlines come back real, dated and sourced, so
            // the model is summarising given text instead of recalling world
            // events — the difference between a digest a 12B model can do
            // well and one it cannot.
            body: 'Call get_news to fetch the headlines for the topics I follow, then write my morning news digest from them. Group the stories by topic, one or two sentences each, and name the source. Only use the headlines the tool returned — never add stories from memory. Lead with whatever is most significant. If the tool says the headlines are stale, say how old they are instead of calling them today’s news. If it returns nothing, say so in one line.'
        },
        {
            id: 'starter-daily-motivation',
            title: 'Daily Motivation',
            config: { offline: true, interval: 'daily', time: '09:00', web: false, useContext: true },
            body: 'Write a short piece of daily motivation that is actually about me. Look at my open tasks and goals — especially anything overdue, stuck, or marked need-help — and write a few encouraging lines that acknowledge what I am working through, then give one concrete, doable suggestion for today. Vary the style day to day: sometimes a fitting quote, sometimes a reframe, sometimes a tiny challenge. Never generic filler.'
        },
        {
            id: 'starter-weekly-reflection',
            title: 'Weekly Reflection',
            config: { offline: true, interval: 'weekly', time: '18:00', web: false, useContext: true },
            body: 'Help me reflect on my week. Review my tasks, goals, and journal: what got completed, what slipped or kept getting pushed, and which goals moved forward or stalled. Write a short, honest reflection — wins first, then patterns worth noticing — and end with three specific questions worth thinking about for next week.'
        }
    ],

    seed() {
        if (typeof NotePrompts === 'undefined' || typeof StorageManager === 'undefined') return;
        if (StorageManager.get(this.KEY)?.ids?.length) return;   // seeded here or on a synced Mac

        const notes = NotePrompts._readNotes();
        const existing = new Set(notes.map(n => n.id));
        const now = new Date().toISOString();
        const fresh = this.ITEMS.filter(it => !existing.has(it.id)).map(it => ({
            id: it.id,
            title: it.title,
            content: NotePrompts._bodyToHtml(it.body),
            tags: [],
            template: 'prompt',
            prompt: { ...NotePrompts.DEFAULTS, ...it.config },
            pinned: false,
            createdAt: now,
            modifiedAt: now
        }));
        if (fresh.length) NotePrompts._writeNotes([...fresh, ...notes]);

        // Anchor every starter except the briefing to its scheduled time —
        // otherwise the first scheduler pass would fire all of them at once.
        const feed = StorageManager.get('promptFeed') || {};
        const runs = (feed.runs && typeof feed.runs === 'object') ? feed.runs : {};
        for (const it of this.ITEMS) {
            if (!it.runImmediately && !runs[it.id]) runs[it.id] = now;
        }
        StorageManager.set('promptFeed', { items: Array.isArray(feed.items) ? feed.items : [], runs });

        StorageManager.set(this.KEY, { ids: this.ITEMS.map(it => it.id) });
    }
};
